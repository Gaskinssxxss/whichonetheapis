import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const STAGES = new Set([
  "initialized",
  "session_check",
  "login_required",
  "waiting_for_user",
  "pricing_open",
  "api_page_open",
  "completed",
  "failed",
]);

export function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function createStateStore({ accountId, runId, outputDir = "output" }) {
  const directory = path.resolve(outputDir, "automation-state", runId);
  const filePath = path.join(directory, `account-${accountId}.json`);
  await mkdir(directory, { recursive: true });

  let state = await readState(filePath);
  if (!state) {
    state = {
      runId,
      accountId: String(accountId),
      stage: "initialized",
      status: "running",
      attempt: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null,
    };
    await persist(filePath, state);
  }

  return {
    filePath,
    get: () => ({ ...state }),
    async transition(stage, details = {}) {
      if (!STAGES.has(stage)) throw new Error(`Unknown automation stage: ${stage}`);
      state = {
        ...state,
        ...details,
        stage,
        updatedAt: new Date().toISOString(),
      };
      await persist(filePath, state);
      return state;
    },
  };
}

async function readState(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function persist(filePath, state) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
}
