import { createRequire } from "node:module";
import fs from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const serverPath = path.join(rootDir, "server.js");
const dataDir = path.join(rootDir, ".tmp-smoke-data", `e2e-${process.pid}`);
const artifactDir = path.join(rootDir, "test-results", "e2e");
const port = 4700 + (process.pid % 300);
const baseUrl = `http://127.0.0.1:${port}`;
const systemBrowserPath = findSystemBrowser();
const slotCount = 48;
const heatScenarioStartSlot = 16;

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(rootDir, ".playwright-browsers");

let serverInstance = null;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });

  let browser;
  try {
    serverInstance = await startServer();
    const { chromium } = await import("@playwright/test");
    try {
      browser = await chromium.launch({
        headless: true,
        ...(systemBrowserPath ? { executablePath: systemBrowserPath } : {}),
      });
    } catch (error) {
      throw new Error(browserLaunchHelp(error));
    }

    const organizerContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
    });
    const organizerPage = await organizerContext.newPage();
    await createTripAsOrganizer(organizerPage);
    await visualCheck(organizerPage, "390-availability");

    const teamCode = await readTeamCode(organizerPage);
    await markBusySlot(organizerPage);
    await organizerPage.waitForTimeout(1500);
    await visualCheck(organizerPage, "390-availability-edited");

    await organizerPage.locator('[data-action="switch-screen"][data-screen="heatmap"]').click();
    await organizerPage.getByText("人时段热力").waitFor();
    await visualCheck(organizerPage, "390-heatmap");

    await organizerPage.locator('[data-action="switch-screen"][data-screen="summary"]').click();
    await organizerPage.getByText("最佳候选已生成").waitFor();
    await visualCheck(organizerPage, "390-summary");

    const downloadPromise = organizerPage.waitForEvent("download");
    await organizerPage.getByRole("button", { name: /添加到日历/ }).click();
    const download = await downloadPromise;
    assert(download.suggestedFilename().endsWith(".ics"), "ICS download did not produce a calendar file.");

    await organizerPage.setViewportSize({ width: 430, height: 932 });
    await visualCheck(organizerPage, "430-summary");

    await organizerPage.setViewportSize({ width: 920, height: 860 });
    await visualCheck(organizerPage, "920-summary");

    const memberContext = await browser.newContext({
      viewport: { width: 430, height: 932 },
    });
    const memberPage = await memberContext.newPage();
    await joinTripAsMember(memberPage, teamCode);
    await visualCheck(memberPage, "430-member-availability");

    await setupHeatmapLevelScenario(teamCode);
    await organizerPage.setViewportSize({ width: 390, height: 844 });
    await organizerPage.reload();
    await organizerPage.getByText("我的时间安排").waitFor();
    await organizerPage.locator('[data-action="switch-screen"][data-screen="heatmap"]').click();
    await organizerPage.getByText("人时段热力").waitFor();
    await assertHeatmapLevels(organizerPage);
    await organizerPage.locator(".screen-body").click({ position: { x: 12, y: 12 } });
    await visualCheck(organizerPage, "390-heatmap-levels");

    await setupHeatmapCompactScenario(teamCode);
    await organizerPage.reload();
    await organizerPage.getByText("我的时间安排").waitFor();
    await organizerPage.locator('[data-action="switch-screen"][data-screen="heatmap"]').click();
    await organizerPage.getByText("人时段热力").waitFor();
    await assertHeatmapCompactState(organizerPage);
    await visualCheck(organizerPage, "390-heatmap-compact");

    console.log(
      JSON.stringify(
        {
          ok: true,
          teamCode,
          artifacts: path.relative(rootDir, artifactDir),
          viewports: ["390x844", "430x932", "920x860"],
        },
        null,
        2
      )
    );
  } finally {
    if (browser) await browser.close();
    await stopServer();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createTripAsOrganizer(page) {
  await page.goto(baseUrl);
  await page.getByText("出游时光机").waitFor();
  await page.getByRole("button", { name: "创建行程" }).click();
  await page.locator('[data-field="userName"]').fill("发起人");
  await page.locator('[data-field="teamName"]').fill("周末露营");
  await page.locator('[data-field="dateDraft"]').fill("2026-05-03");
  await page.getByRole("button", { name: "添加" }).click();
  await page.locator('[data-field="durationHours"]').fill("1.5");
  await page.getByRole("button", { name: /创建行程并开始/ }).click();
  await page.getByText("我的时间安排").waitFor();
}

async function joinTripAsMember(page, teamCode) {
  await page.goto(baseUrl);
  await page.getByText("出游时光机").waitFor();
  await page.locator('[data-field="userName"]').fill("成员A");
  await page.locator('[data-field="teamCode"]').fill(teamCode);
  await page.locator('[data-action="submit-login"]').click();
  await page.getByText("我的时间安排").waitFor();
  await page.locator('[data-action="set-active-date"]').last().click();
  await markBusySlot(page);
  await page.waitForTimeout(1500);
}

async function markBusySlot(page) {
  const slot = page.locator('[data-action="toggle-slot"]').first();
  await slot.waitFor();
  await slot.click();
}

async function readTeamCode(page) {
  const text = await page.locator(".team-chip-row").innerText();
  const match = text.match(/行程口令：([A-Z2-9]{4,6})/);
  assert(match, `Could not read team code from: ${text}`);
  return match[1];
}

async function setupHeatmapLevelScenario(teamCode) {
  const snapshot = await readSnapshot(teamCode);
  const targetDate = snapshot.team.tripDates[0];
  const organizer = snapshot.members.find((member) => member.role === "发起人") || snapshot.members[0];
  const member = snapshot.members.find((item) => item.id !== organizer.id);
  assert(targetDate, "Heatmap scenario needs a trip date.");
  assert(organizer && member, "Heatmap scenario needs two members.");

  const organizerAvailability = Array(slotCount).fill(false);
  const memberAvailability = Array(slotCount).fill(false);
  organizerAvailability[heatScenarioStartSlot] = true;
  organizerAvailability[heatScenarioStartSlot + 1] = true;
  organizerAvailability[heatScenarioStartSlot + 2] = true;
  organizerAvailability[heatScenarioStartSlot + 3] = true;
  organizerAvailability[heatScenarioStartSlot + 4] = true;
  organizerAvailability[heatScenarioStartSlot + 6] = true;
  memberAvailability[heatScenarioStartSlot] = true;

  await writeMemberAvailability(teamCode, organizer.id, targetDate, organizerAvailability);
  await writeMemberAvailability(teamCode, member.id, targetDate, memberAvailability);
}

async function setupHeatmapCompactScenario(teamCode) {
  const snapshot = await readSnapshot(teamCode);
  const targetDate = snapshot.team.tripDates[0];
  const organizer = snapshot.members.find((member) => member.role === "发起人") || snapshot.members[0];
  const member = snapshot.members.find((item) => item.id !== organizer.id);
  assert(targetDate, "Compact heatmap scenario needs a trip date.");
  assert(organizer && member, "Compact heatmap scenario needs two members.");

  const organizerAvailability = Array(slotCount).fill(true);
  const memberAvailability = Array(slotCount).fill(true);
  organizerAvailability[heatScenarioStartSlot + 1] = false;
  organizerAvailability[heatScenarioStartSlot + 3] = false;
  organizerAvailability[heatScenarioStartSlot + 5] = false;
  memberAvailability[heatScenarioStartSlot + 2] = false;

  await writeMemberAvailability(teamCode, organizer.id, targetDate, organizerAvailability);
  await writeMemberAvailability(teamCode, member.id, targetDate, memberAvailability);
}

async function assertHeatmapLevels(page) {
  const cells = page.locator(".heat-cell");
  await cells.first().waitFor();

  const classNames = await Promise.all([0, 1, 5, 6].map((offset) => cells.nth(offset).getAttribute("class")));
  assert(classNames[0]?.includes("heat-full"), `2/2 slot should be green/full: ${classNames[0]}`);
  assert(classNames[1]?.includes("heat-half"), `1/2 slot should be half-level, not green: ${classNames[1]}`);
  assert(!classNames[1]?.includes("heat-full"), `1/2 slot must not use green/full class: ${classNames[1]}`);
  assert(classNames[2]?.includes("heat-none"), `0/2 slot should be red/none: ${classNames[2]}`);
  assert(classNames[3]?.includes("heat-half"), `Short 1/2 slot should still keep half-level color: ${classNames[3]}`);

  await page.getByText("1人不空闲").waitFor();
  const heatLabels = await page.locator(".heat-busy-label").evaluateAll((elements) => elements.map((element) => element.textContent.trim()));
  assert(
    heatLabels.filter((text) => text === "1人不空闲").length === 1,
    `Only the long 1-person-busy segment should show a visible label: ${JSON.stringify(heatLabels)}`
  );
  assert(!heatLabels.includes("0人不空闲"), `Fully available segments must not show busy labels: ${JSON.stringify(heatLabels)}`);

  const shortSlotLabel = await cells.nth(6).getAttribute("aria-label");
  assert(shortSlotLabel?.includes("1人不空闲"), `Short hidden-label segment should keep aria detail: ${shortSlotLabel}`);

  await cells.nth(1).hover();
  await page.locator('[data-role="heat-tooltip"]').waitFor();
  const tooltipText = await page.locator('[data-role="heat-tooltip"]').innerText();
  assert(tooltipText.includes("08:30-09:00"), `Tooltip should include slot range: ${tooltipText}`);
  assert(tooltipText.includes("1人不空闲 / 1人空闲"), `Tooltip should include busy/free counts: ${tooltipText}`);
  assert(tooltipText.includes("不空闲：成员A"), `Tooltip should include busy member: ${tooltipText}`);
  assert(tooltipText.includes("空闲：发起人"), `Tooltip should include available member: ${tooltipText}`);

  await cells.nth(0).click();
  const pinnedTooltip = await page.locator('[data-role="heat-tooltip"]').innerText();
  assert(pinnedTooltip.includes("2人空闲"), `Clicking another heat cell should update tooltip content: ${pinnedTooltip}`);

  await page.locator(".screen-body").click({ position: { x: 12, y: 12 } });
  await page.waitForFunction(() => document.querySelector('[data-role="heat-tooltip"]')?.hasAttribute("hidden"));

  const chips = await page.locator(".distribution-row .availability-chip").evaluateAll((elements) =>
    elements.slice(0, 10).map((element) => ({
      text: element.textContent.trim(),
      className: element.className,
    }))
  );
  assert(chips[0]?.text.includes("2/2") && chips[0].className.includes("full"), `Top 10 full chip mismatch: ${JSON.stringify(chips[0])}`);
  assert(chips[1]?.text.includes("1/2") && chips[1].className.includes("half"), `Top 10 half chip mismatch: ${JSON.stringify(chips[1])}`);
  assert(
    chips.filter((chip) => chip.text.includes("1/2")).every((chip) => chip.className.includes("half") && !chip.className.includes("full")),
    `Top 10 1/2 chips must stay half-level, not green: ${JSON.stringify(chips)}`
  );
  const noneChip = chips.find((chip) => chip.text.includes("0/2"));
  assert(noneChip?.className.includes("none"), `Top 10 none chip mismatch: ${JSON.stringify(noneChip)}`);
}

async function assertHeatmapCompactState(page) {
  const labelStripCount = await page.locator(".heat-label-strip").count();
  assert(labelStripCount === 0, `Heat label strip should not render when all busy segments are shorter than 4 slots: ${labelStripCount}`);

  const cells = page.locator(".heat-cell");
  const compactLabel = await cells.nth(1).getAttribute("aria-label");
  assert(compactLabel?.includes("1人不空闲"), `Compact scenario should still keep busy detail in aria label: ${compactLabel}`);
}

async function readSnapshot(teamCode) {
  const response = await fetch(`${baseUrl}/api/teams/${encodeURIComponent(teamCode)}`);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Could not read team snapshot: ${response.status} ${text}`);
  }
  return response.json();
}

async function writeMemberAvailability(teamCode, memberId, tripDate, availability) {
  const response = await fetch(`${baseUrl}/api/teams/${encodeURIComponent(teamCode)}/members/${memberId}/availability`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tripDate, availability }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Could not write member availability: ${response.status} ${text}`);
  }
}

async function visualCheck(page, name) {
  await assertNoHorizontalOverflow(page, name);
  await assertNoClippedControls(page, name);
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`), fullPage: true });
}

async function assertNoHorizontalOverflow(page, name) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert(
    metrics.scrollWidth <= metrics.clientWidth + 1 && metrics.bodyScrollWidth <= metrics.clientWidth + 1,
    `${name} has horizontal overflow: ${JSON.stringify(metrics)}`
  );
}

async function assertNoClippedControls(page, name) {
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll("button, .team-chip, .date-chip, .status-pill, .availability-chip, .heat-busy-label, .heat-tooltip")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
      })
      .slice(0, 8)
      .map((element) => ({
        text: element.textContent.trim(),
        className: element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      }))
  );
  assert(clipped.length === 0, `${name} has clipped controls: ${JSON.stringify(clipped, null, 2)}`);
}

async function startServer() {
  process.env.HOST = "127.0.0.1";
  process.env.PORT = String(port);
  process.env.DATA_DIR = dataDir;
  delete require.cache[require.resolve(serverPath)];
  const server = require(serverPath);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      const health = await response.json();
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

function findSystemBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_EXECUTABLE_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function browserLaunchHelp(error) {
  const detail = error?.message || String(error);
  return [
    "Playwright could not launch a browser for E2E verification.",
    "Run `npm run browsers:install` to install Chromium into .playwright-browsers/, or set PLAYWRIGHT_EXECUTABLE_PATH to Chrome/Edge.",
    "If this runs inside a restricted sandbox, allow browser process launches and rerun `npm run test:e2e`.",
    detail,
  ].join("\n");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
