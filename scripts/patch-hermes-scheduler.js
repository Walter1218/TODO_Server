#!/usr/bin/env node
/**
 * patch-hermes-scheduler.js
 *
 * Node.js wrapper invoked by `npm run patch:hermes` (or postinstall).
 * Calls the Python patcher with the correct HERMES_HOME and credentials.
 *
 * Usage:
 *   node scripts/patch-hermes-scheduler.js [hermes_home]
 *
 * The patcher is idempotent — safe to run multiple times.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PYTHON_CMD = process.platform === "win32" ? "python" : "python3";
const PATCHER = path.resolve(__dirname, "patch-hermes-scheduler.py");

function readHermesEnv(hermesHome) {
  const envPath = path.join(hermesHome, ".env");
  if (!fs.existsSync(envPath)) return {};

  const env = {};
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (!m) continue;
    env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

function resolveHermesHome(arg) {
  if (arg) return path.resolve(arg);
  return path.join(os.homedir(), ".hermes");
}

function runPatcher(hermesHome, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...extraEnv };
    const args = [PATCHER, hermesHome];

    console.log(`[patch:hermes] Calling Python patcher with HERMES_HOME=${hermesHome}`);

    const child = spawn(PYTHON_CMD, args, {
      env,
      stdio: "inherit",
      shell: false,
    });

    child.on("close", (code) => {
      resolve(code === 0 || code === undefined ? 0 : code);
    });

    child.on("error", (err) => {
      console.error(`[patch:hermes] Spawn error: ${err.message}`);
      resolve(1);
    });
  });
}

async function main() {
  const hermesHome = resolveHermesHome(process.argv[2] || process.env.HERMES_HOME);

  // Hermes not installed — skip silently
  const schedulerPath = path.join(hermesHome, "hermes-agent", "cron", "scheduler.py");
  if (!fs.existsSync(schedulerPath)) {
    console.log(
      `[patch:hermes] Hermes not found at ${hermesHome} — skipping Hermes unified scheduling patch.\n` +
      `Install Hermes first, then run: node scripts/patch-hermes-scheduler.js`
    );
    process.exit(0);
  }

  // Pass through the ops agent credentials from Hermes .env so the Python
  // patcher doesn't need to read .env itself (cross-process env isolation).
  const hermesEnv = readHermesEnv(hermesHome);
  const extraEnv = {};
  if (hermesEnv.HERMES_OPS_TODO_SECRET) {
    extraEnv.HERMES_OPS_TODO_SECRET = hermesEnv.HERMES_OPS_TODO_SECRET;
  }
  if (hermesEnv.HERMES_OPS_AGENT_ID) {
    extraEnv.HERMES_OPS_AGENT_ID = hermesEnv.HERMES_OPS_AGENT_ID;
  }

  const exitCode = await runPatcher(hermesHome, extraEnv);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`[patch:hermes] Unexpected error: ${err.message}`);
  process.exit(1);
});
