import dotenv from "dotenv";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

dotenv.config({ path: process.env.RAPIDAPI_ENV_FILE ?? ".env" });

const accountIds = Object.keys(process.env)
  .map((key) => key.match(/^RAPIDAPI_ACCOUNT_(\d+)_EMAIL$/)?.[1])
  .filter(Boolean)
  .map(Number)
  .sort((a, b) => a - b)
  .filter((accountId) => {
    const start = Number(process.env.RAPIDAPI_START_ACCOUNT ?? "0");
    const end = Number(process.env.RAPIDAPI_END_ACCOUNT ?? "999999");
    return accountId >= start && accountId <= end;
  });

if (accountIds.length === 0) {
  console.error("No RAPIDAPI_ACCOUNT_N_EMAIL entries found in .env.");
  process.exit(1);
}

const results = [];
const runStartedAt = new Date();
const concurrency = Math.max(1, Number(process.env.RAPIDAPI_CONCURRENCY ?? "1"));

let nextAccountIndex = 0;

await Promise.all(
  Array.from({ length: Math.min(concurrency, accountIds.length) }, async (_, workerIndex) => {
    while (nextAccountIndex < accountIds.length) {
      const accountId = accountIds[nextAccountIndex];
      nextAccountIndex += 1;
      console.log("");
      console.log(`=== Account ${accountId} (worker ${workerIndex + 1}/${concurrency}) ===`);
      const result = await runAccount(accountId);
      results.push({ accountId, ...result });
    }
  }),
);

results.sort((a, b) => a.accountId - b.accountId);

if (concurrency > 1) {
  console.log(`parallel_workers=${concurrency}`);
}

console.log("");
console.log("=== Summary ===");
for (const result of results) {
  const suffix = result.keySuffix ? ` key=...${result.keySuffix}` : "";
  console.log(`${result.status} account=${result.accountId}${suffix}`);
}

const okCount = results.filter((result) => result.status === "OK").length;
const successRate = results.length ? Math.round((okCount / results.length) * 100) : 0;
console.log(`success=${okCount}/${results.length} (${successRate}%)`);

await writeResults(results, runStartedAt, successRate);

if (successRate < Number(process.env.RAPIDAPI_MIN_SUCCESS_PERCENT ?? "80")) {
  process.exitCode = 1;
}

async function runAccount(accountId) {
  return await new Promise((resolve) => {
    const child = spawn("node", ["scripts/login-rapidapi-google.mjs"], {
      env: {
        ...process.env,
        RAPIDAPI_ACCOUNT: String(accountId),
        RAPIDAPI_AUTO_CLOSE: "1",
        RAPIDAPI_SKIP_CHALLENGE: process.env.RAPIDAPI_SKIP_CHALLENGE ?? "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let pendingKey = false;
    let keySuffix = "";
    let challengeSkipped = false;

    const handleLine = (line, isError = false) => {
      const trimmed = line.trimEnd();
      if (!trimmed) {
        return;
      }

      if (pendingKey) {
        keySuffix = trimmed.slice(-6);
        console.log("X-RapidAPI-Key: <masked>");
        pendingKey = false;
        return;
      }

      if (trimmed === "X-RapidAPI-Key:") {
        pendingKey = true;
        return;
      }

      if (trimmed.includes("CHALLENGE_SKIPPED") || trimmed.includes("Challenge skip mode enabled")) {
        challengeSkipped = true;
      }

      const stream = isError ? process.stderr : process.stdout;
      stream.write(`${trimmed}\n`);
    };

    wireLines(child.stdout, (line) => handleLine(line));
    wireLines(child.stderr, (line) => handleLine(line, true));

    child.on("close", (code) => {
      resolve({
        status: code === 0 ? "OK" : challengeSkipped || code === 20 ? "CHALLENGE" : "FAIL",
        keySuffix,
      });
    });
  });
}

async function writeResults(results, startedAt, successRate) {
  const outputDir = path.resolve("output");
  await mkdir(outputDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `rapidapi-run-${stamp}.json`);
  const csvPath = path.join(outputDir, `rapidapi-run-${stamp}.csv`);
  const payload = {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    successRate,
    results,
  };

  await writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(
    csvPath,
    [
      "account,status,key_suffix",
      ...results.map((result) => `${result.accountId},${result.status},${result.keySuffix ?? ""}`),
    ].join("\n") + "\n",
  );
  console.log(`results_json=${jsonPath}`);
  console.log(`results_csv=${csvPath}`);
}

function wireLines(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  });
  stream.on("end", () => {
    if (buffer) {
      onLine(buffer);
    }
  });
}
