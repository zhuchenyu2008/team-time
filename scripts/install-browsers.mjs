import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const cliPath = path.join(rootDir, "node_modules", "playwright", "cli.js");

const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
  cwd: rootDir,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(rootDir, ".playwright-browsers"),
  },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Playwright browser installation stopped by ${signal}.`);
    process.exit(1);
  }
  process.exit(code || 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
