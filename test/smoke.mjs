import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createStateStore } from "../scripts/automation/state-store.mjs";

const root = path.resolve(".");
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "whichonetheapis-test-"));

try {
  assertExit(run("node", ["scripts/request-rapidapi.mjs", "--help"]), 0, "request help");

  const invalidHostEnv = path.join(temporaryDirectory, "invalid-host.env");
  await writeEnv(invalidHostEnv, [
    "RAPIDAPI_API_KEY=test-key",
    "RAPIDAPI_HOST=bad host",
    "RAPIDAPI_ENDPOINT=/v1/example",
  ]);
  assertMatch(
    assertExit(run("node", ["scripts/request-rapidapi.mjs"], { RAPIDAPI_ENV_FILE: invalidHostEnv }), 1, "invalid host").stderr,
    /RAPIDAPI_HOST must be a hostname/,
  );

  const invalidMethodEnv = path.join(temporaryDirectory, "invalid-method.env");
  await writeEnv(invalidMethodEnv, [
    "RAPIDAPI_API_KEY=test-key",
    "RAPIDAPI_HOST=example-api.p.rapidapi.com",
    "RAPIDAPI_ENDPOINT=/v1/example",
    "RAPIDAPI_METHOD=TRACE",
  ]);
  assertMatch(
    assertExit(run("node", ["scripts/request-rapidapi.mjs"], { RAPIDAPI_ENV_FILE: invalidMethodEnv }), 1, "invalid method").stderr,
    /RAPIDAPI_METHOD must be/,
  );

  const stateOutput = path.join(temporaryDirectory, "state-output");
  const stateStore = await createStateStore({ accountId: 7, runId: "smoke-run", outputDir: stateOutput });
  await stateStore.transition("waiting_for_user", { status: "waiting" });
  const state = JSON.parse(await readFile(stateStore.filePath, "utf8"));
  assert.equal(state.accountId, "7");
  assert.equal(state.stage, "waiting_for_user");
  assert.equal(state.status, "waiting");

  const statusResult = assertExit(
    run("node", ["scripts/automation/status.mjs", "smoke-run"], { RAPIDAPI_OUTPUT_DIR: stateOutput }),
    0,
    "automation status",
  );
  assertMatch(statusResult.stdout, /waiting:waiting_for_user=1/);

  for (const script of [
    "scripts/request-rapidapi.mjs",
    "scripts/automation/state-store.mjs",
    "scripts/automation/status.mjs",
    "scripts/login-rapidapi-google.mjs",
    "scripts/run-all-rapidapi-accounts.mjs",
  ]) {
    assertExit(run("node", ["--check", script]), 0, `syntax ${script}`);
  }

  console.log("Smoke tests passed.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function run(command, args, environment = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function assertExit(result, expectedStatus, label) {
  assert.equal(result.error, undefined, `${label}: process failed to start`);
  assert.equal(result.status, expectedStatus, `${label}:\n${result.stderr || result.stdout}`);
  return result;
}

function assertMatch(value, expression) {
  assert.match(value, expression);
}

async function writeEnv(filePath, lines) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, `${lines.join("\n")}\n`);
}
