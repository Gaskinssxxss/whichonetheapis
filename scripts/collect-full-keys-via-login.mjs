import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const accountIds = (process.env.RAPIDAPI_COLLECT_ACCOUNTS ?? "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value));
const concurrency = Math.max(1, Number(process.env.RAPIDAPI_COLLECT_CONCURRENCY ?? "2"));
const outputPath = path.resolve(process.env.RAPIDAPI_COLLECT_OUTPUT ?? "output/rapidapi-collected-full-keys.json");

if (accountIds.length === 0) {
  console.error("Set RAPIDAPI_COLLECT_ACCOUNTS, e.g. 9,12,44");
  process.exit(1);
}

const results = [];
let nextIndex = 0;

await Promise.all(
  Array.from({ length: Math.min(concurrency, accountIds.length) }, async () => {
    while (nextIndex < accountIds.length) {
      const accountId = accountIds[nextIndex];
      nextIndex += 1;
      results.push(await runAccount(accountId));
    }
  }),
);

results.sort((a, b) => a.accountId - b.accountId);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`);

for (const result of results) {
  if (result.key) {
    console.log(`OK account=${result.accountId} key=...${result.key.slice(-6)}`);
  } else {
    console.log(`FAIL account=${result.accountId} error=${result.error}`);
  }
}
console.log(`full_keys_json=${outputPath}`);

if (results.some((result) => !result.key)) {
  process.exitCode = 1;
}

async function runAccount(accountId) {
  return await new Promise((resolve) => {
    const child = spawn("node", ["scripts/login-rapidapi-google.mjs"], {
      env: {
        ...process.env,
        RAPIDAPI_ACCOUNT: String(accountId),
        RAPIDAPI_AUTO_CLOSE: "1",
        RAPIDAPI_SKIP_CHALLENGE: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let pendingKey = false;
    let key = "";
    let outputTail = "";

    const handleData = (chunk) => {
      const text = chunk.toString();
      outputTail = (outputTail + text).slice(-2000);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        if (pendingKey) {
          key = trimmed;
          pendingKey = false;
          continue;
        }

        if (trimmed === "X-RapidAPI-Key:") {
          pendingKey = true;
        }
      }
    };

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);
    child.on("close", (code) => {
      resolve({
        accountId,
        key,
        error: key ? "" : `exit=${code}; tail=${outputTail.replace(/\s+/g, " ").slice(-500)}`,
      });
    });
  });
}
