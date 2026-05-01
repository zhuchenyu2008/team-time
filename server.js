const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4173);
const SLOT_COUNT = 48;
const SLOT_STEP = 30;
const DAY_START_MIN = 0;
const DAY_END_MIN = 24 * 60;
const DEFAULT_DAY_START_MIN = 8 * 60;
const DEFAULT_DAY_END_MIN = 22 * 60;
const DEFAULT_DURATION_MINUTES = 120;
const LEGACY_SLOT_COUNT = 28;
const LEGACY_START_INDEX = DEFAULT_DAY_START_MIN / SLOT_STEP;
const DEFAULT_TRIP_TIME = Object.freeze({
  durationMinutes: DEFAULT_DURATION_MINUTES,
  dayStartMinutes: DEFAULT_DAY_START_MIN,
  dayEndMinutes: DEFAULT_DAY_END_MIN,
});

const ROOT_DIR = __dirname;
const ROOT_DIR_RESOLVED = path.resolve(ROOT_DIR);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, "data");
const DB_PATH = path.join(DATA_DIR, "team-time.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    trip_date TEXT NOT NULL,
    trip_dates TEXT NOT NULL DEFAULT '[]',
    duration_minutes INTEGER NOT NULL DEFAULT 120,
    day_start_min INTEGER NOT NULL DEFAULT 480,
    day_end_min INTEGER NOT NULL DEFAULT 1320,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '成员',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(team_id, name),
    FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS availabilities (
    member_id INTEGER NOT NULL,
    trip_date TEXT NOT NULL,
    slot_index INTEGER NOT NULL CHECK(slot_index >= 0 AND slot_index < ${SLOT_COUNT}),
    is_available INTEGER NOT NULL CHECK(is_available IN (0, 1)),
    PRIMARY KEY(member_id, trip_date, slot_index),
    FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
  );
`);

ensureColumnExists("teams", "trip_dates", "TEXT NOT NULL DEFAULT '[]'");
ensureColumnExists("teams", "duration_minutes", "INTEGER NOT NULL DEFAULT 120");
ensureColumnExists("teams", "day_start_min", "INTEGER NOT NULL DEFAULT 480");
ensureColumnExists("teams", "day_end_min", "INTEGER NOT NULL DEFAULT 1320");
backfillTripDates();
ensureAvailabilityDateSchema();
ensureAvailabilitySlotSchema();

const stmt = {
  teamByCode: db.prepare(`
    SELECT id, code, name, trip_date AS tripDate, trip_dates AS tripDatesRaw,
           duration_minutes AS durationMinutes,
           day_start_min AS dayStartMinutes,
           day_end_min AS dayEndMinutes
    FROM teams
    WHERE code = ?
  `),
  teamExistsByCode: db.prepare("SELECT 1 FROM teams WHERE code = ? LIMIT 1"),
  insertTeam: db.prepare(`
    INSERT INTO teams(code, name, trip_date, trip_dates, duration_minutes, day_start_min, day_end_min)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `),
  updateTeam: db.prepare(`
    UPDATE teams
    SET name = ?, trip_date = ?, trip_dates = ?, duration_minutes = ?, day_start_min = ?, day_end_min = ?
    WHERE id = ?
  `),
  memberByIdAndTeam: db.prepare(`
    SELECT id, team_id AS teamId, name, role
    FROM members
    WHERE id = ? AND team_id = ?
  `),
  memberByNameAndTeam: db.prepare(`
    SELECT id, team_id AS teamId, name, role
    FROM members
    WHERE team_id = ? AND lower(name) = lower(?)
    LIMIT 1
  `),
  insertMember: db.prepare("INSERT INTO members(team_id, name, role) VALUES(?, ?, ?)"),
  membersByTeam: db.prepare(`
    SELECT id, team_id AS teamId, name, role
    FROM members
    WHERE team_id = ?
    ORDER BY id ASC
  `),
  memberCountByTeam: db.prepare("SELECT count(1) AS total FROM members WHERE team_id = ?"),
  deleteMemberByIdAndTeam: db.prepare("DELETE FROM members WHERE id = ? AND team_id = ?"),
  availabilityByTeam: db.prepare(`
    SELECT a.member_id AS memberId, a.trip_date AS tripDate, a.slot_index AS slotIndex, a.is_available AS isAvailable
    FROM availabilities a
    JOIN members m ON m.id = a.member_id
    WHERE m.team_id = ?
    ORDER BY a.member_id ASC, a.trip_date ASC, a.slot_index ASC
  `),
  upsertAvailability: db.prepare(`
    INSERT INTO availabilities(member_id, trip_date, slot_index, is_available)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(member_id, trip_date, slot_index)
    DO UPDATE SET is_available = excluded.is_available
  `),
  insertAvailabilityIfMissing: db.prepare(`
    INSERT OR IGNORE INTO availabilities(member_id, trip_date, slot_index, is_available)
    VALUES(?, ?, ?, ?)
  `),
  deleteAvailabilityByTeamAndDate: db.prepare(`
    DELETE FROM availabilities
    WHERE trip_date = ?
      AND member_id IN (SELECT id FROM members WHERE team_id = ?)
  `),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }
  return handleStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Team Time running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});

server.on("close", () => {
  db.close();
});

module.exports = server;

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === "POST" && url.pathname === "/api/teams") {
      const body = await readJsonBody(req);
      const teamName = sanitizeTeamName(body.teamName);
      const userName = sanitizeName(body.userName);
      const tripDates = sanitizeTripDates(body.tripDates || body.tripDate);
      const primaryTripDate = tripDates[0] || "";
      const tripTime = normalizeTripTime(body);

      if (!teamName) {
        return sendJson(res, 400, { error: "行程名称不能为空。" });
      }
      if (!userName) {
        return sendJson(res, 400, { error: "昵称不能为空。" });
      }
      if (!primaryTripDate) {
        return sendJson(res, 400, { error: "请至少选择一个有效计划日期。" });
      }
      if (!tripTime) {
        return sendJson(res, 400, { error: "行程时间必须使用 30 分钟粒度，且范围需覆盖预计行程时长。" });
      }

      const result = transact(() => {
        const code = generateTeamCode();
        const insertTeam = stmt.insertTeam.run(
          code,
          teamName,
          primaryTripDate,
          JSON.stringify(tripDates),
          tripTime.durationMinutes,
          tripTime.dayStartMinutes,
          tripTime.dayEndMinutes
        );
        const teamId = Number(insertTeam.lastInsertRowid);
        const insertMember = stmt.insertMember.run(teamId, userName, "发起人");
        const memberId = Number(insertMember.lastInsertRowid);
        ensureMemberSlots(memberId, tripDates);
        return createSnapshotByTeamCode(code, memberId);
      });

      return sendJson(res, 201, result);
    }

    if (req.method === "POST" && url.pathname === "/api/teams/join") {
      const body = await readJsonBody(req);
      const teamCode = sanitizeTeamCode(body.teamCode);
      const userName = sanitizeName(body.userName);

      if (!teamCode || teamCode.length < 4) {
        return sendJson(res, 400, { error: "行程口令格式不正确。" });
      }
      if (!userName) {
        return sendJson(res, 400, { error: "昵称不能为空。" });
      }

      const team = stmt.teamByCode.get(teamCode);
      if (!team) {
        return sendJson(res, 404, { error: "未找到该行程，请确认口令后重试。" });
      }

      const result = transact(() => {
        const existing = stmt.memberByNameAndTeam.get(team.id, userName);
        let memberId;
        if (existing) {
          memberId = Number(existing.id);
          ensureMemberSlots(memberId, parseTripDates(team.tripDatesRaw, team.tripDate));
        } else {
          const inserted = stmt.insertMember.run(team.id, userName, "成员");
          memberId = Number(inserted.lastInsertRowid);
          ensureMemberSlots(memberId, parseTripDates(team.tripDatesRaw, team.tripDate));
        }
        return createSnapshotByTeamCode(teamCode, memberId);
      });

      return sendJson(res, 200, result);
    }

    const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)$/);
    if (teamMatch) {
      const teamCode = sanitizeTeamCode(teamMatch[1]);
      if (!teamCode) {
        return sendJson(res, 400, { error: "行程口令无效。" });
      }

      if (req.method === "GET") {
        const memberId = toSafeInt(url.searchParams.get("memberId"));
        const snapshot = createSnapshotByTeamCode(teamCode, memberId);
        if (!snapshot) {
          return sendJson(res, 404, { error: "行程不存在。" });
        }
        return sendJson(res, 200, snapshot);
      }

      if (req.method === "PATCH") {
        const body = await readJsonBody(req);
        const team = stmt.teamByCode.get(teamCode);
        if (!team) {
          return sendJson(res, 404, { error: "行程不存在。" });
        }
        const memberId = toSafeInt(url.searchParams.get("memberId"));
        if (!memberId) {
          return sendJson(res, 400, { error: "缺少发起人身份信息。" });
        }
        const member = stmt.memberByIdAndTeam.get(memberId, team.id);
        if (!member) {
          return sendJson(res, 404, { error: "成员不存在。" });
        }
        if (member.role !== "发起人") {
          return sendJson(res, 403, { error: "只有发起人可以修改行程设置。" });
        }

        const teamName = body.teamName === undefined ? team.name : sanitizeTeamName(body.teamName);
        const currentTripDates = parseTripDates(team.tripDatesRaw, team.tripDate);
        const nextTripDates =
          body.tripDates === undefined && body.tripDate === undefined
            ? currentTripDates
            : sanitizeTripDates(body.tripDates || body.tripDate);
        const currentTripTime = tripTimeFromTeam(team);
        const nextTripTime = normalizeTripTime(body, currentTripTime);
        const tripDate = nextTripDates[0] || "";
        if (!teamName) {
          return sendJson(res, 400, { error: "行程名称不能为空。" });
        }
        if (!tripDate || nextTripDates.length === 0) {
          return sendJson(res, 400, { error: "请至少选择一个有效计划日期。" });
        }
        if (!nextTripTime) {
          return sendJson(res, 400, { error: "行程时间必须使用 30 分钟粒度，且范围需覆盖预计行程时长。" });
        }

        const snapshot = transact(() => {
          stmt.updateTeam.run(
            teamName,
            tripDate,
            JSON.stringify(nextTripDates),
            nextTripTime.durationMinutes,
            nextTripTime.dayStartMinutes,
            nextTripTime.dayEndMinutes,
            team.id
          );
          syncTeamDateSlots(team.id, currentTripDates, nextTripDates);
          return createSnapshotByTeamCode(teamCode, memberId);
        });
        return sendJson(res, 200, snapshot);
      }
    }

    const memberAvailabilityMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/members\/(\d+)\/availability$/);
    if (memberAvailabilityMatch && req.method === "PUT") {
      const teamCode = sanitizeTeamCode(memberAvailabilityMatch[1]);
      const memberId = toSafeInt(memberAvailabilityMatch[2]);
      if (!teamCode || !memberId) {
        return sendJson(res, 400, { error: "请求参数不合法。" });
      }
      const body = await readJsonBody(req);
      const availability = normalizeAvailability(body.availability);
      if (!availability) {
        return sendJson(res, 400, { error: `availability 必须是 ${SLOT_COUNT} 位布尔数组。` });
      }

      const team = stmt.teamByCode.get(teamCode);
      if (!team) {
        return sendJson(res, 404, { error: "行程不存在。" });
      }

      const member = stmt.memberByIdAndTeam.get(memberId, team.id);
      if (!member) {
        return sendJson(res, 404, { error: "成员不存在。" });
      }
      const tripDates = parseTripDates(team.tripDatesRaw, team.tripDate);
      const tripDate = body.tripDate === undefined ? tripDates[0] || "" : sanitizeTripDate(body.tripDate);
      if (!tripDate || !tripDates.includes(tripDate)) {
        return sendJson(res, 400, { error: "请选择当前行程中的有效日期。" });
      }

      const snapshot = transact(() => {
        writeAvailability(memberId, tripDate, availability);
        return createSnapshotByTeamCode(teamCode, memberId);
      });
      return sendJson(res, 200, snapshot);
    }

    const membersCollectionMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/members$/);
    if (membersCollectionMatch) {
      const teamCode = sanitizeTeamCode(membersCollectionMatch[1]);
      if (!teamCode) {
        return sendJson(res, 400, { error: "行程口令无效。" });
      }
      const team = stmt.teamByCode.get(teamCode);
      if (!team) {
        return sendJson(res, 404, { error: "行程不存在。" });
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const name = sanitizeName(body.name);
        if (!name) {
          return sendJson(res, 400, { error: "成员昵称不能为空。" });
        }
        const existing = stmt.memberByNameAndTeam.get(team.id, name);
        if (existing) {
          return sendJson(res, 409, { error: "成员昵称已存在。" });
        }

        const tripDates = parseTripDates(team.tripDatesRaw, team.tripDate);
        const availability = body.availability ? normalizeAvailability(body.availability) : availabilityByPattern(body.pattern);
        if (!availability) {
          return sendJson(res, 400, { error: "成员时段格式不正确。" });
        }

        const currentMemberId = toSafeInt(url.searchParams.get("memberId"));
        const snapshot = transact(() => {
          const inserted = stmt.insertMember.run(team.id, name, "成员");
          const newMemberId = Number(inserted.lastInsertRowid);
          ensureMemberSlots(newMemberId, tripDates);
          tripDates.forEach((date) => writeAvailability(newMemberId, date, availability));
          return createSnapshotByTeamCode(teamCode, currentMemberId);
        });

        return sendJson(res, 201, snapshot);
      }
    }

    const memberMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/members\/(\d+)$/);
    if (memberMatch && req.method === "DELETE") {
      const teamCode = sanitizeTeamCode(memberMatch[1]);
      const targetMemberId = toSafeInt(memberMatch[2]);
      const currentMemberId = toSafeInt(url.searchParams.get("memberId"));
      if (!teamCode || !targetMemberId) {
        return sendJson(res, 400, { error: "请求参数不合法。" });
      }

      const team = stmt.teamByCode.get(teamCode);
      if (!team) {
        return sendJson(res, 404, { error: "行程不存在。" });
      }

      const member = stmt.memberByIdAndTeam.get(targetMemberId, team.id);
      if (!member) {
        return sendJson(res, 404, { error: "成员不存在。" });
      }

      const count = stmt.memberCountByTeam.get(team.id);
      if (count.total <= 1) {
        return sendJson(res, 400, { error: "至少保留一位成员。" });
      }

      const snapshot = transact(() => {
        stmt.deleteMemberByIdAndTeam.run(targetMemberId, team.id);
        return createSnapshotByTeamCode(teamCode, currentMemberId);
      });

      return sendJson(res, 200, snapshot);
    }

    return sendJson(res, 404, { error: "未找到接口。" });
  } catch (error) {
    console.error(error);
    if (error.message === "Invalid JSON body.") {
      return sendJson(res, 400, { error: "请求体必须是有效 JSON。" });
    }
    if (error.message === "Request body too large.") {
      return sendJson(res, 413, { error: "请求体过大。" });
    }
    return sendJson(res, 500, { error: "服务内部错误，请稍后重试。" });
  }
}

function handleStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendText(res, 405, "Method Not Allowed");
  }

  const pathname = decodeURIComponent(url.pathname);
  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  const directPath = pathname === "/" ? path.join(ROOT_DIR, "index.html") : path.join(ROOT_DIR, pathname.slice(1));
  const resolvedDirect = path.resolve(directPath);
  if (!isPathInsideRoot(resolvedDirect)) {
    return sendText(res, 403, "Forbidden");
  }

  if (fs.existsSync(resolvedDirect) && fs.statSync(resolvedDirect).isFile()) {
    return sendFile(res, resolvedDirect, req.method === "HEAD");
  }

  const fallback = path.join(ROOT_DIR, "index.html");
  return sendFile(res, fallback, req.method === "HEAD");
}

function sendFile(res, filePath, headOnly) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".js"
        ? "application/javascript; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : "application/octet-stream";
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": contentType, "Content-Length": content.length });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(content);
}

function isPathInsideRoot(filePath) {
  const relative = path.relative(ROOT_DIR_RESOLVED, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sendJson(res, statusCode, data) {
  const text = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body.");
  }
}

function sanitizeName(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.slice(0, 16);
}

function sanitizeTeamName(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return text.slice(0, 30);
}

function sanitizeTeamCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, 6);
}

function sanitizeTripDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return "";
  }
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return "";
  }
  return text;
}

function sanitizeTripDates(value) {
  const source = Array.isArray(value) ? value : [value];
  const set = new Set();
  source.forEach((item) => {
    const date = sanitizeTripDate(item);
    if (date) {
      set.add(date);
    }
  });
  return [...set].sort();
}

function normalizeTripTime(input, fallback = DEFAULT_TRIP_TIME) {
  const source = input && typeof input === "object" ? input : {};
  const durationMinutes =
    source.durationMinutes === undefined ? fallback.durationMinutes : toTripTimeInt(source.durationMinutes);
  const dayStartMinutes =
    source.dayStartMinutes === undefined ? fallback.dayStartMinutes : toTripTimeInt(source.dayStartMinutes);
  const dayEndMinutes = source.dayEndMinutes === undefined ? fallback.dayEndMinutes : toTripTimeInt(source.dayEndMinutes);
  if (!Number.isInteger(durationMinutes) || !Number.isInteger(dayStartMinutes) || !Number.isInteger(dayEndMinutes)) {
    return null;
  }
  if (durationMinutes < SLOT_STEP || durationMinutes > DAY_END_MIN - DAY_START_MIN || durationMinutes % SLOT_STEP !== 0) {
    return null;
  }
  if (dayStartMinutes < DAY_START_MIN || dayEndMinutes > DAY_END_MIN) {
    return null;
  }
  if (dayStartMinutes % SLOT_STEP !== 0 || dayEndMinutes % SLOT_STEP !== 0) {
    return null;
  }
  if (dayEndMinutes <= dayStartMinutes || dayEndMinutes - dayStartMinutes < durationMinutes) {
    return null;
  }
  return { durationMinutes, dayStartMinutes, dayEndMinutes };
}

function tripTimeFromTeam(team) {
  return (
    normalizeTripTime({
      durationMinutes: team?.durationMinutes,
      dayStartMinutes: team?.dayStartMinutes,
      dayEndMinutes: team?.dayEndMinutes,
    }) || DEFAULT_TRIP_TIME
  );
}

function toTripTimeInt(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function parseTripDates(raw, fallbackDate) {
  let parsed = [];
  if (typeof raw === "string" && raw.trim()) {
    try {
      const list = JSON.parse(raw);
      parsed = sanitizeTripDates(list);
    } catch {
      parsed = [];
    }
  }
  if (parsed.length === 0) {
    const fallback = sanitizeTripDate(fallbackDate);
    if (fallback) {
      parsed = [fallback];
    }
  }
  return parsed;
}

function normalizeTripDateList(value) {
  const dates = sanitizeTripDates(value);
  return dates.length ? dates : [];
}

function toSafeInt(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    return null;
  }
  return number;
}

function normalizeAvailability(value) {
  if (!Array.isArray(value) || value.length !== SLOT_COUNT) {
    return null;
  }
  return value.map((item) => Boolean(item));
}

function availabilityByPattern(pattern) {
  const source = Array(SLOT_COUNT).fill(false);
  const key = String(pattern || "afternoon");
  if (key === "morning") {
    for (let i = 16; i < 24; i += 1) source[i] = true;
    return source;
  }
  if (key === "evening") {
    for (let i = 36; i < 44; i += 1) source[i] = true;
    return source;
  }
  if (key === "all") {
    return source.map(() => true);
  }
  for (let i = 26; i < 36; i += 1) source[i] = true;
  return source;
}

function writeAvailability(memberId, tripDate, availability) {
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    stmt.upsertAvailability.run(memberId, tripDate, slot, availability[slot] ? 1 : 0);
  }
}

function ensureMemberSlots(memberId, tripDates) {
  const dates = normalizeTripDateList(tripDates);
  dates.forEach((date) => {
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      stmt.insertAvailabilityIfMissing.run(memberId, date, slot, 1);
    }
  });
}

function syncTeamDateSlots(teamId, previousDates, nextDates) {
  const previous = new Set(normalizeTripDateList(previousDates));
  const next = normalizeTripDateList(nextDates);
  const members = stmt.membersByTeam.all(teamId);

  next.forEach((date) => {
    members.forEach((member) => ensureMemberSlots(member.id, [date]));
  });

  previous.forEach((date) => {
    if (!next.includes(date)) {
      stmt.deleteAvailabilityByTeamAndDate.run(date, teamId);
    }
  });
}

function createSnapshotByTeamCode(teamCode, currentMemberId) {
  const team = stmt.teamByCode.get(teamCode);
  if (!team) {
    return null;
  }
  const tripDates = parseTripDates(team.tripDatesRaw, team.tripDate);
  const tripTime = tripTimeFromTeam(team);

  const members = stmt.membersByTeam.all(team.id);
  const rows = stmt.availabilityByTeam.all(team.id);
  const availabilityByMemberId = new Map();

  members.forEach((member) => {
    const byDate = {};
    tripDates.forEach((date) => {
      byDate[date] = Array(SLOT_COUNT).fill(true);
    });
    availabilityByMemberId.set(member.id, byDate);
  });

  rows.forEach((row) => {
    const byDate = availabilityByMemberId.get(row.memberId);
    const date = sanitizeTripDate(row.tripDate);
    if (byDate && tripDates.includes(date) && row.slotIndex >= 0 && row.slotIndex < SLOT_COUNT) {
      byDate[date][row.slotIndex] = Boolean(row.isAvailable);
    }
  });

  const membersPayload = members.map((member) => ({
    id: member.id,
    name: member.name,
    role: member.role,
    availability: (availabilityByMemberId.get(member.id) || {})[tripDates[0]] || Array(SLOT_COUNT).fill(true),
    availabilityByDate: availabilityByMemberId.get(member.id) || {},
  }));

  const currentMember =
    currentMemberId && membersPayload.find((member) => member.id === currentMemberId)
      ? membersPayload.find((member) => member.id === currentMemberId)
      : null;

  return {
    team: {
      code: team.code,
      name: team.name,
      tripDate: team.tripDate,
      tripDates,
      durationMinutes: tripTime.durationMinutes,
      dayStartMinutes: tripTime.dayStartMinutes,
      dayEndMinutes: tripTime.dayEndMinutes,
    },
    currentMember,
    members: membersPayload,
  };
}

function generateTeamCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let round = 0; round < 60; round += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    const exists = stmt.teamExistsByCode.get(code);
    if (!exists) {
      return code;
    }
  }
  throw new Error("Failed to generate unique team code.");
}

function ensureColumnExists(tableName, columnName, definitionSql) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = rows.some((row) => row.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
  }
}

function backfillTripDates() {
  const rows = db.prepare("SELECT id, trip_date AS tripDate, trip_dates AS tripDatesRaw FROM teams").all();
  const update = db.prepare("UPDATE teams SET trip_dates = ? WHERE id = ?");
  rows.forEach((row) => {
    const list = parseTripDates(row.tripDatesRaw, row.tripDate);
    update.run(JSON.stringify(list), row.id);
  });
}

function ensureAvailabilityDateSchema() {
  const columns = db.prepare("PRAGMA table_info(availabilities)").all();
  const hasTripDate = columns.some((row) => row.name === "trip_date");
  if (hasTripDate) return;

  const legacyRows = db
    .prepare(
      `
      SELECT a.member_id AS memberId,
             a.slot_index AS slotIndex,
             a.is_available AS isAvailable,
             t.trip_date AS tripDate,
             t.trip_dates AS tripDatesRaw
      FROM availabilities a
      JOIN members m ON m.id = a.member_id
      JOIN teams t ON t.id = m.team_id
    `
    )
    .all();

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("ALTER TABLE availabilities RENAME TO availabilities_legacy;");
  db.exec(`
    CREATE TABLE availabilities (
      member_id INTEGER NOT NULL,
      trip_date TEXT NOT NULL,
      slot_index INTEGER NOT NULL CHECK(slot_index >= 0 AND slot_index < ${LEGACY_SLOT_COUNT}),
      is_available INTEGER NOT NULL CHECK(is_available IN (0, 1)),
      PRIMARY KEY(member_id, trip_date, slot_index),
      FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
    );
  `);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO availabilities(member_id, trip_date, slot_index, is_available)
    VALUES(?, ?, ?, ?)
  `);
  legacyRows.forEach((row) => {
    parseTripDates(row.tripDatesRaw, row.tripDate).forEach((date) => {
      insert.run(row.memberId, date, row.slotIndex, row.isAvailable ? 1 : 0);
    });
  });

  db.exec("DROP TABLE availabilities_legacy;");
  db.exec("PRAGMA foreign_keys = ON;");
}

function ensureAvailabilitySlotSchema() {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'availabilities'").get();
  const sql = String(info?.sql || "");
  if (sql.includes(`slot_index < ${SLOT_COUNT}`)) return;

  const legacyRows = db
    .prepare(
      `
      SELECT a.member_id AS memberId,
             a.trip_date AS tripDate,
             a.slot_index AS slotIndex,
             a.is_available AS isAvailable,
             t.day_start_min AS dayStartMinutes,
             t.day_end_min AS dayEndMinutes
      FROM availabilities a
      JOIN members m ON m.id = a.member_id
      JOIN teams t ON t.id = m.team_id
    `
    )
    .all();

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("ALTER TABLE availabilities RENAME TO availabilities_legacy_slot;");
  db.exec(`
    CREATE TABLE availabilities (
      member_id INTEGER NOT NULL,
      trip_date TEXT NOT NULL,
      slot_index INTEGER NOT NULL CHECK(slot_index >= 0 AND slot_index < ${SLOT_COUNT}),
      is_available INTEGER NOT NULL CHECK(is_available IN (0, 1)),
      PRIMARY KEY(member_id, trip_date, slot_index),
      FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
    );
  `);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO availabilities(member_id, trip_date, slot_index, is_available)
    VALUES(?, ?, ?, ?)
  `);
  legacyRows.forEach((row) => {
    const slot = Number(row.slotIndex);
    const dayStart = Number(row.dayStartMinutes);
    const dayEnd = Number(row.dayEndMinutes);
    const looksLegacy =
      LEGACY_SLOT_COUNT === 28 && sql.includes("slot_index < 28") && dayStart >= DEFAULT_DAY_START_MIN && dayEnd <= DEFAULT_DAY_END_MIN;
    const nextSlot = looksLegacy ? slot + LEGACY_START_INDEX : slot;
    if (nextSlot >= 0 && nextSlot < SLOT_COUNT) {
      insert.run(row.memberId, row.tripDate, nextSlot, row.isAvailable ? 1 : 0);
    }
  });

  db.exec("DROP TABLE availabilities_legacy_slot;");
  db.exec("PRAGMA foreign_keys = ON;");
}

function transact(work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
