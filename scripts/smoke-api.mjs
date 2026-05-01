import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const serverPath = path.join(rootDir, "server.js");
const dataDir = path.join(rootDir, ".tmp-smoke-data", `api-${process.pid}`);
const port = 4300 + (process.pid % 400);
const baseUrl = `http://127.0.0.1:${port}`;

let serverInstance = null;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });

  let summary;
  try {
    serverInstance = await startServer();
    const firstRun = await runApiFlow();
    await stopServer();

    serverInstance = await startServer();
    const persisted = await getJson(`/api/teams/${firstRun.teamCode}?memberId=${firstRun.organizerId}`);
    assert(persisted.team.code === firstRun.teamCode, "Team code was not persisted after restart.");
    assert(persisted.members.length === 2, "Members were not persisted after restart.");
    assert(arrayEquals(persisted.team.tripDates, ["2026-05-03", "2026-05-04"]), "Trip dates were not persisted after restart.");

    summary = {
      ok: true,
      teamCode: firstRun.teamCode,
      members: persisted.members.length,
      dates: persisted.team.tripDates,
      dataDir,
    };
  } finally {
    await stopServer();
    await rm(dataDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify(summary, null, 2));
}

async function runApiFlow() {
  const health = await getJson("/api/health");
  assert(health.ok === true, "Health check failed.");

  const created = await postJson("/api/teams", {
    teamName: "五一试运行",
    userName: "发起人",
    tripDates: ["2026-05-02", "2026-05-03"],
    durationMinutes: 120,
    dayStartMinutes: 540,
    dayEndMinutes: 1080,
  });
  assert(created.team?.code, "Create response did not include a team code.");
  assert(arrayEquals(created.team.tripDates, ["2026-05-02", "2026-05-03"]), "Create response did not include both dates.");
  assert(created.team.durationMinutes === 120, "Create response did not include duration.");

  const teamCode = created.team.code;
  const organizerId = created.currentMember.id;

  const joined = await postJson("/api/teams/join", {
    teamCode,
    userName: "成员A",
  });
  assert(joined.currentMember?.id, "Join response did not include current member.");
  assert(joined.members.length === 2, "Join response did not include both members.");
  const memberId = joined.currentMember.id;

  const availability = Array.from({ length: 48 }, (_, index) => index < 4);
  const updated = await putJson(`/api/teams/${teamCode}/members/${memberId}/availability`, {
    tripDate: "2026-05-03",
    availability,
  });
  const joinedMember = updated.members.find((member) => member.id === memberId);
  assert(joinedMember.availabilityByDate["2026-05-03"][0] === true, "Availability was not written to the selected date.");
  assert(joinedMember.availabilityByDate["2026-05-03"][4] === false, "Availability wrote the wrong slot pattern.");

  await expectStatus(
    "PUT",
    `/api/teams/${teamCode}/members/${memberId}/availability`,
    { tripDate: "2026-02-31", availability },
    400
  );

  await expectStatus(
    "PATCH",
    `/api/teams/${teamCode}?memberId=${memberId}`,
    { teamName: "成员越权修改" },
    403
  );

  const patched = await patchJson(`/api/teams/${teamCode}?memberId=${organizerId}`, {
    teamName: "五一试运行更新",
    tripDates: ["2026-05-03", "2026-05-04"],
    durationMinutes: 90,
    dayStartMinutes: 600,
    dayEndMinutes: 1050,
  });
  assert(arrayEquals(patched.team.tripDates, ["2026-05-03", "2026-05-04"]), "Organizer patch did not sync date list.");
  assert(patched.team.durationMinutes === 90, "Organizer patch did not sync duration.");

  return { teamCode, organizerId };
}

async function startServer() {
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(port);
  process.env.DATA_DIR = dataDir;
  delete require.cache[require.resolve(serverPath)];
  const server = require(serverPath);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const health = await getJson("/api/health", { timeoutMs: 500 });
      if (health.ok) return server;
    } catch {
      await delay(250);
    }
  }

  await closeServer(server);
  throw new Error("Server did not become ready.");
}

async function stopServer() {
  if (!serverInstance) return;
  const server = serverInstance;
  serverInstance = null;
  await closeServer(server);
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

function getJson(urlPath, options = {}) {
  return requestJson("GET", urlPath, undefined, options);
}

function postJson(urlPath, body) {
  return requestJson("POST", urlPath, body);
}

function putJson(urlPath, body) {
  return requestJson("PUT", urlPath, body);
}

function patchJson(urlPath, body) {
  return requestJson("PATCH", urlPath, body);
}

async function expectStatus(method, urlPath, body, expectedStatus) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status !== expectedStatus) {
    const text = await response.text().catch(() => "");
    throw new Error(`Expected ${method} ${urlPath} to return ${expectedStatus}, got ${response.status}. ${text}`);
  }
}

async function requestJson(method, urlPath, body, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 5000);
  try {
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${method} ${urlPath} failed with ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function arrayEquals(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
