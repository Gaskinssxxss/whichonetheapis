import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const outputDir = path.resolve(process.env.RAPIDAPI_OUTPUT_DIR ?? "output", "automation-state");
const requestedRunId = process.argv[2];
const runIds = requestedRunId ? [requestedRunId] : await readdir(outputDir).catch(() => []);

if (runIds.length === 0) {
  console.log("No automation state found.");
  process.exit(0);
}

for (const runId of runIds.sort()) {
  const runDir = path.join(outputDir, runId);
  const files = (await readdir(runDir).catch(() => [])).filter((name) => name.endsWith(".json"));
  const states = await Promise.all(files.map(async (name) => JSON.parse(await readFile(path.join(runDir, name), "utf8"))));
  const counts = states.reduce((groups, state) => {
    const key = `${state.status}:${state.stage}`;
    (groups[key] ??= []).push(state);
    return groups;
  }, {});
  console.log(`run=${runId} accounts=${states.length}`);
  for (const [status, entries] of Object.entries(counts).sort()) console.log(`  ${status}=${entries.length}`);
}
