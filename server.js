const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4173);
const SLOT_COUNT = 28;

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
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
    slot_index INTEGER NOT NULL CHECK(slot_index >= 0 AND slot_index < 28),
    is_available INTEGER NOT NULL CHECK(is_available IN (0, 1)),
    PRIMARY KEY(member_id, slot_index),
    FOREIGN KEY(member_id) REFERENCES members(id) ON DELETE CASCADE
  );
`);

const stmt = {
  teamByCode: db.prepare("SELECT id, code, name, trip_date AS tripDate FROM teams WHERE code = ?"),
  teamExistsByCode: db.prepare("SELECT 1 FROM teams WHERE code = ? LIMIT 1"),
  insertTeam: db.prepare("INSERT INTO teams(code, name, trip_date) VALUES(?, ?, ?)"),
  updateTeam: db.prepare("UPDATE teams SET name = ?, trip_date = ? WHERE id = ?"),
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
    SELECT a.member_id AS memberId, a.slot_index AS slotIndex, a.is_available AS isAvailable
    FROM availabilities a
    JOIN members m ON m.id = a.member_id
    WHERE m.team_id = ?
    ORDER BY a.member_id ASC, a.slot_index ASC
  `),
  upsertAvailability: db.prepare(`
    INSERT INTO availabilities(member_id, slot_index, is_available)
    VALUES(?, ?, ?)
    ON CONFLICT(member_id, slot_index)
    DO UPDATE SET is_available = excluded.is_available
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

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === "POST" && url.pathname === "/api/teams") {
      const body = await readJsonBody(req);
      const teamName = sanitizeTeamName(body.teamName);
      const userName = sanitizeName(body.userName);
      const tripDate = sanitizeTripDate(body.tripDate);

      if (!teamName) {
        return sendJson(res, 400, { error: "团队名称不能为空。" });
      }
      if (!userName) {
        return sendJson(res, 400, { error: "昵称不能为空。" });
      }
      if (!tripDate) {
        return sendJson(res, 400, { error: "计划日期格式不正确。" });
      }

      const result = transact(() => {
        const code = generateTeamCode();
        const insertTeam = stmt.insertTeam.run(code, teamName, tripDate);
        const teamId = Number(insertTeam.lastInsertRowid);
        const insertMember = stmt.insertMember.run(teamId, userName, "发起人");
        const memberId = Number(insertMember.lastInsertRowid);
        ensureMemberSlots(memberId);
        return createSnapshotByTeamCode(code, memberId);
      });

      return sendJson(res, 201, result);
    }

    if (req.method === "POST" && url.pathname === "/api/teams/join") {
      const body = await readJsonBody(req);
      const teamCode = sanitizeTeamCode(body.teamCode);
      const userName = sanitizeName(body.userName);

      if (!teamCode || teamCode.length < 4) {
        return sendJson(res, 400, { error: "团队口令格式不正确。" });
      }
      if (!userName) {
        return sendJson(res, 400, { error: "昵称不能为空。" });
      }

      const team = stmt.teamByCode.get(teamCode);
      if (!team) {
        return sendJson(res, 404, { error: "未找到该团队，请确认口令后重试。" });
      }

      const result = transact(() => {
        const existing = stmt.memberByNameAndTeam.get(team.id, userName);
        let memberId;
        if (existing) {
          memberId = Number(existing.id);
        } else {
          const inserted = stmt.insertMember.run(team.id, userName, "成员");
          memberId = Number(inserted.lastInsertRowid);
          ensureMemberSlots(memberId);
        }
        return createSnapshotByTeamCode(teamCode, memberId);
      });

      return sendJson(res, 200, result);
    }

    const teamMatch = url.pathname.match(/^\/api\/teams\/([^/]+)$/);
    if (teamMatch) {
      const teamCode = sanitizeTeamCode(teamMatch[1]);
      if (!teamCode) {
        return sendJson(res, 400, { error: "团队口令无效。" });
      }

      if (req.method === "GET") {
        const memberId = toSafeInt(url.searchParams.get("memberId"));
        const snapshot = createSnapshotByTeamCode(teamCode, memberId);
        if (!snapshot) {
          return sendJson(res, 404, { error: "团队不存在。" });
        }
        return sendJson(res, 200, snapshot);
      }

      if (req.method === "PATCH") {
        const body = await readJsonBody(req);
        const team = stmt.teamByCode.get(teamCode);
        if (!team) {
          return sendJson(res, 404, { error: "团队不存在。" });
        }

        const teamName = body.teamName === undefined ? team.name : sanitizeTeamName(body.teamName);
        const tripDate = body.tripDate === undefined ? team.tripDate : sanitizeTripDate(body.tripDate);
        if (!teamName) {
          return sendJson(res, 400, { error: "团队名称不能为空。" });
        }
        if (!tripDate) {
          return sendJson(res, 400, { error: "计划日期格式不正确。" });
        }

        const memberId = toSafeInt(url.searchParams.get("memberId"));
        const snapshot = transact(() => {
          stmt.updateTeam.run(teamName, tripDate, team.id);
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
        return sendJson(res, 400, { error: "availability 必须是 28 位布尔数组。" });
      }

      const team = stmt.teamByCode.get(teamCode);
      if (!team) {
        return sendJson(res, 404, { error: "团队不存在。" });
      }

      const member = stmt.memberByIdAndTeam.get(memberId, team.id);
      if (!member) {
        return sendJson(res, 404, { error: "成员不存在。" });
      }

      const snapshot = transact(() => {
        writeAvailability(memberId, availability);
        return createSnapshotByTeamCode(teamCode, memberId);
      });
      return sendJson(res, 200, snapshot);
    }

    const membersCollectionMatch = url.pathname.match(/^\/api\/teams\/([^/]+)\/members$/);
    if (membersCollectionMatch) {
      const teamCode = sanitizeTeamCode(membersCollectionMatch[1]);
      if (!teamCode) {
        return sendJson(res, 400, { error: "团队口令无效。" });
      }
      const team = stmt.teamByCode.get(teamCode);
      if (!team) {
        return sendJson(res, 404, { error: "团队不存在。" });
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

        const availability = body.availability ? normalizeAvailability(body.availability) : availabilityByPattern(body.pattern);
        if (!availability) {
          return sendJson(res, 400, { error: "成员时段格式不正确。" });
        }

        const currentMemberId = toSafeInt(url.searchParams.get("memberId"));
        const snapshot = transact(() => {
          const inserted = stmt.insertMember.run(team.id, name, "成员");
          const newMemberId = Number(inserted.lastInsertRowid);
          ensureMemberSlots(newMemberId);
          writeAvailability(newMemberId, availability);
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
        return sendJson(res, 404, { error: "团队不存在。" });
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
  if (!resolvedDirect.startsWith(path.resolve(ROOT_DIR))) {
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
  return text;
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
    for (let i = 0; i < 8; i += 1) source[i] = true;
    return source;
  }
  if (key === "evening") {
    for (let i = 20; i < SLOT_COUNT; i += 1) source[i] = true;
    return source;
  }
  if (key === "all") {
    return source.map(() => true);
  }
  for (let i = 8; i < 20; i += 1) source[i] = true;
  return source;
}

function writeAvailability(memberId, availability) {
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    stmt.upsertAvailability.run(memberId, slot, availability[slot] ? 1 : 0);
  }
}

function ensureMemberSlots(memberId) {
  const allFalse = Array(SLOT_COUNT).fill(false);
  writeAvailability(memberId, allFalse);
}

function createSnapshotByTeamCode(teamCode, currentMemberId) {
  const team = stmt.teamByCode.get(teamCode);
  if (!team) {
    return null;
  }

  const members = stmt.membersByTeam.all(team.id);
  const rows = stmt.availabilityByTeam.all(team.id);
  const availabilityByMemberId = new Map();

  members.forEach((member) => {
    availabilityByMemberId.set(member.id, Array(SLOT_COUNT).fill(false));
  });

  rows.forEach((row) => {
    const list = availabilityByMemberId.get(row.memberId);
    if (list && row.slotIndex >= 0 && row.slotIndex < SLOT_COUNT) {
      list[row.slotIndex] = Boolean(row.isAvailable);
    }
  });

  const membersPayload = members.map((member) => ({
    id: member.id,
    name: member.name,
    role: member.role,
    availability: availabilityByMemberId.get(member.id) || Array(SLOT_COUNT).fill(false),
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
