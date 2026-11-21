import { chromium } from "playwright";
import dotenv from "dotenv";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

dotenv.config({ path: process.env.RAPIDAPI_ENV_FILE ?? ".env" });

const apiUrl =
  "https://rapidapi.com/thestatsapi/api/football-stats-api-live-scores-xg-odds-player-data";
const outputPath = path.resolve(process.env.RAPIDAPI_KEYS_OUTPUT ?? "output/rapidapi-keys.txt");
const concurrency = Math.max(1, Number(process.env.RAPIDAPI_EXTRACT_CONCURRENCY ?? "4"));
const startAccount = Number(process.env.RAPIDAPI_START_ACCOUNT ?? "1");
const endAccount = Number(process.env.RAPIDAPI_END_ACCOUNT ?? "999999");

const accountIds = Object.keys(process.env)
  .map((key) => key.match(/^RAPIDAPI_ACCOUNT_(\d+)_EMAIL$/)?.[1])
  .filter(Boolean)
  .map(Number)
  .sort((a, b) => a - b)
  .filter((accountId) => accountId >= startAccount && accountId <= endAccount);

if (accountIds.length === 0) {
  console.error("No RAPIDAPI_ACCOUNT_N_EMAIL entries found for the requested range.");
  process.exit(1);
}

const results = [];
let nextAccountIndex = 0;

await Promise.all(
  Array.from({ length: Math.min(concurrency, accountIds.length) }, async () => {
    while (nextAccountIndex < accountIds.length) {
      const accountId = accountIds[nextAccountIndex];
      nextAccountIndex += 1;
      const result = await extractAccountKey(accountId);
      results.push(result);
    }
  }),
);

results.sort((a, b) => a.accountId - b.accountId);

const okResults = results.filter((result) => result.key);
const lines = okResults.map((result, index) => `rapidapikey_${keyLabel(index)}=${result.key}`);

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${lines.join("\n")}\n`);

for (const result of results) {
  if (result.key) {
    console.log(`OK account=${result.accountId} key=...${result.key.slice(-6)}`);
  } else {
    console.log(`FAIL account=${result.accountId} error=${result.error}`);
  }
}

console.log(`keys_written=${okResults.length}`);
console.log(`keys_txt=${outputPath}`);

if (okResults.length === 0) {
  process.exitCode = 1;
}

async function extractAccountKey(accountId) {
  const authDir = path.resolve(".auth");
  const storageStatePath = path.join(authDir, `rapidapi-account-${accountId}-state.json`);
  const userDataDir = path.join(authDir, `rapidapi-account-${accountId}-profile`);
  let context;

  try {
    if (!(await fileExists(userDataDir)) && !(await fileExists(storageStatePath))) {
      return { accountId, key: "", error: "missing saved state/profile" };
    }

    context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      viewport: { width: 1365, height: 768 },
      locale: "en-US",
    });

    if (await fileExists(storageStatePath)) {
      await importStorageCookies(context, storageStatePath);
    }

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(7_000);
    page.setDefaultNavigationTimeout(30_000);

    await page.goto(apiUrl, { waitUntil: "domcontentloaded" });
    await waitForDomReady(page);
    await dismissRapidApiInterruptions(page);

    let key = await waitForRapidApiKeyToAppear(context, 8_000);
    if (key) {
      return { accountId, key, error: "" };
    }

    await clickActionOptional(page, [
      page.getByRole("tab", { name: /authorization/i }),
      page.getByRole("button", { name: /authorization/i }),
      page.getByRole("link", { name: /authorization/i }),
      page.getByText(/authorization/i),
    ]);
    key = await waitForRapidApiKeyToAppear(context, 8_000);
    if (key) {
      return { accountId, key, error: "" };
    }

    await clickActionOptional(page, [
      page.getByRole("link", { name: /open playground/i }),
      page.getByRole("button", { name: /open playground/i }),
      page.getByText(/open playground/i),
    ]);
    await waitForDomReady(page);
    await dismissRapidApiInterruptions(page);

    await clickActionOptional(page, [
      page.getByRole("tab", { name: /authorization/i }),
      page.getByRole("button", { name: /authorization/i }),
      page.getByRole("link", { name: /authorization/i }),
      page.getByText(/authorization/i),
    ]);

    key = await waitForRapidApiKeyToAppear(context, 12_000);
    if (key) {
      return { accountId, key, error: "" };
    }

    return { accountId, key: "", error: "key not found" };
  } catch (error) {
    return {
      accountId,
      key: "",
      error: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : String(error),
    };
  } finally {
    await context?.close().catch(() => {});
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function importStorageCookies(context, filePath) {
  try {
    const state = JSON.parse(await readFile(filePath, "utf8"));
    if (Array.isArray(state.cookies) && state.cookies.length > 0) {
      await context.addCookies(state.cookies);
    }
  } catch {
    // Profile cookies are still available when the explicit storage state cannot be imported.
  }
}

async function dismissRapidApiInterruptions(page) {
  await clickActionOptional(page, [
    page.getByRole("button", { name: /reject all/i }),
    page.getByText(/reject all/i),
  ]);
  await clickActionOptional(page, [
    page.getByRole("button", { name: /dismiss notification/i }),
    page.getByText(/dismiss notification/i),
  ]);
}

async function clickActionOptional(page, locators) {
  for (const locator of locators) {
    try {
      const first = locator.first();
      await first.waitFor({ state: "visible", timeout: 1_000 });
      await first.scrollIntoViewIfNeeded();
      await first.click();
      await waitForDomReady(page);
      return true;
    } catch {
      // Try the next locator.
    }
  }

  return false;
}

async function waitForDomReady(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
  } catch {
    // Continue with DOM extraction.
  }
}

async function waitForRapidApiKeyToAppear(context, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const key = await extractRapidApiKey(context);
    if (key) {
      return key;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return "";
}

async function extractRapidApiKey(context) {
  for (const openPage of context.pages()) {
    if (!openPage.url().includes("rapidapi.com")) {
      continue;
    }

    const key = await openPage.evaluate(() => {
      const keyPattern = /[A-Za-z0-9_-]{32,}/;

      function clean(value) {
        return value
          ?.replace(/^["'`]+|["'`,;]+$/g, "")
          .trim();
      }

      function fromText(text) {
        const normalized = text.replace(/\s+/g, " ");
        const direct = normalized.match(
          /X-RapidAPI-Key[^A-Za-z0-9_-]{1,80}([A-Za-z0-9_-]{32,})/i,
        );
        if (direct) {
          return clean(direct[1]);
        }

        const headerStyle = normalized.match(
          /["']x-rapidapi-key["']\s*:\s*["']([^"']{32,})["']/i,
        );
        if (headerStyle) {
          return clean(headerStyle[1]);
        }

        return null;
      }

      const labelCandidates = [...document.querySelectorAll("body *")].filter((element) =>
        /X-RapidAPI-Key/i.test(element.textContent ?? ""),
      );

      for (const label of labelCandidates) {
        let scope = label;
        for (let depth = 0; scope && depth < 7; depth += 1) {
          const field = scope.querySelector("input, textarea");
          const fieldValue = clean(field?.value);
          if (fieldValue && keyPattern.test(fieldValue) && !/X-RapidAPI-Key/i.test(fieldValue)) {
            return fieldValue;
          }

          const scopedText = fromText(scope.textContent ?? "");
          if (scopedText) {
            return scopedText;
          }

          scope = scope.parentElement;
        }
      }

      return fromText(document.body?.innerText ?? document.body?.textContent ?? "");
    });

    if (key) {
      return key;
    }
  }

  return "";
}

function keyLabel(index) {
  let value = index;
  let label = "";

  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);

  return label;
}
