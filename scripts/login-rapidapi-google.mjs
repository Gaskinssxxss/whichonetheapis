import { chromium } from "playwright";
import dotenv from "dotenv";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { Blob } from "node:buffer";
import path from "node:path";

dotenv.config({ path: process.env.RAPIDAPI_ENV_FILE ?? ".env" });

const loginUrl = "https://rapidapi.com/auth/sign-in";
const pricingUrl =
  "https://rapidapi.com/thestatsapi/api/football-stats-api-live-scores-xg-odds-player-data/pricing";
const apiUrl =
  "https://rapidapi.com/thestatsapi/api/football-stats-api-live-scores-xg-odds-player-data";
const timeoutMs = Number(process.env.RAPIDAPI_LOGIN_TIMEOUT_MS ?? 180_000);
const keyTimeoutMs = Number(process.env.RAPIDAPI_KEY_TIMEOUT_MS ?? 35_000);
const telegramPollMs = Number(process.env.RAPIDAPI_TELEGRAM_POLL_MS ?? 3_000);
const selectedAccount = process.env.RAPIDAPI_ACCOUNT ?? "1";
const skipChallenge = process.env.RAPIDAPI_SKIP_CHALLENGE === "1";
const { googleEmail, googlePassword } = getGoogleCredentials(selectedAccount);
const telegramBotToken =
  process.env.TELEGRAM_BOT_TOKEN ?? process.env.RAPIDAPI_TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN;
let telegramChatId =
  process.env.TELEGRAM_CHAT_ID ?? process.env.RAPIDAPI_TELEGRAM_CHAT_ID ?? process.env.CHAT_ID;
const authDir = path.resolve(".auth");
const storageStatePath = path.join(authDir, `rapidapi-account-${selectedAccount}-state.json`);
const userDataDir = path.join(authDir, `rapidapi-account-${selectedAccount}-profile`);

await mkdir(authDir, { recursive: true });
const hasSavedStateFile = await fileExists(storageStatePath);
const hasSavedProfile = await fileExists(userDataDir);
const hasSavedState = hasSavedStateFile || hasSavedProfile;

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: ["--start-maximized"],
  viewport: null,
  locale: "en-US",
});

if (hasSavedStateFile) {
  await importStorageCookies(context, storageStatePath);
}

const page = context.pages()[0] ?? (await context.newPage());
page.setDefaultTimeout(10_000);
page.setDefaultNavigationTimeout(45_000);

try {
  console.log(`Using account slot: ${selectedAccount}`);
  let rapidApiPage = page;

  if (hasSavedState) {
    console.log(`Found saved login state for account slot ${selectedAccount}.`);
    console.log(`Opening pricing page: ${pricingUrl}`);
    await page.goto(pricingUrl, { waitUntil: "domcontentloaded" });
    await waitForDomReady(page);
    await dismissInterruptions(page);
  }

  if (hasSavedState && !(await needsSignIn(page))) {
    console.log("Saved login state is still valid. Continuing without Google sign-in.");
  } else {
    if (hasSavedState) {
      console.log("Saved login state is expired or not accepted. Signing in again.");
    }

    console.log("Opening RapidAPI sign-in page...");
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await dismissInterruptions(page);

    const alreadySignedIn = await isSignedIn(page);
    if (alreadySignedIn) {
      console.log("Already signed in in this browser context.");
    } else {
      await clickGoogleSignIn(page);
      const authPage = await waitForGoogleAuthPage(context, page);
      await fillGoogleCredentials(authPage);

      console.log("");
      console.log("Complete Google sign-in in the browser window.");
      console.log("If Google asks for MFA, CAPTCHA, or account confirmation, finish it manually.");
      console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds for RapidAPI to load...`);
      rapidApiPage = await waitForRapidApiAfterLogin(context, timeoutMs);
    }

    await context.storageState({ path: storageStatePath });
    console.log(`Saved login state for account slot ${selectedAccount}: ${storageStatePath}`);
  }

  console.log("Login ready. Continuing to subscription workflow.");
  const rapidApiKey = await subscribeAndExtractKey(rapidApiPage, context);

  console.log("");
  console.log("X-RapidAPI-Key:");
  console.log(rapidApiKey);
  await notifyTelegram(
    `RapidAPI account ${selectedAccount} sukses. X-RapidAPI-Key: ...${rapidApiKey.slice(-6)}`,
  );
  if (process.env.RAPIDAPI_AUTO_CLOSE === "1") {
    console.log("Auto-close enabled. Closing browser.");
  } else {
    await waitForEnter("Press Enter to close the browser...");
  }
} catch (error) {
  console.error("");
  console.error("Login automation stopped:");
  console.error(error instanceof Error ? error.message : error);
  console.error("");
  console.error("Tip: rerun `npm run login:rapidapi` and finish any Google verification manually.");
  if (error instanceof Error && error.message === "CHALLENGE_SKIPPED") {
    process.exitCode = 20;
  } else {
  await notifyTelegram(
    `RapidAPI account ${selectedAccount} gagal: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
  }
} finally {
  await context.close();
}

async function clickGoogleSignIn(page) {
  const candidates = [
    page.getByRole("button", { name: /google/i }),
    page.getByRole("link", { name: /google/i }),
    page.getByText(/continue with google/i),
    page.getByText(/sign in with google/i),
    page.getByText(/google/i),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.first().click({ timeout: 5_000 });
      console.log("Clicked Google sign-in.");
      await dismissInterruptions(page);
      return;
    } catch {
      // Try the next selector. RapidAPI changes button markup occasionally.
    }
  }

  console.log("Could not find a Google button automatically.");
  console.log("Please click the Google sign-in option manually in the browser.");
}

async function waitForGoogleAuthPage(context, fallbackPage) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const googlePage = context.pages().find((openPage) => {
      const href = openPage.url();
      return isGoogleAuthUrl(href) || href === "about:blank";
    });
    if (googlePage) {
      googlePage.setDefaultTimeout(20_000);
      await googlePage.bringToFront();
      if (googlePage.url() === "about:blank") {
        try {
          await googlePage.waitForURL((url) => isGoogleAuthUrl(url.toString()), {
            timeout: 15_000,
          });
        } catch {
          // Some providers reuse the same tab. The loop will keep looking.
        }
      }
      if (isGoogleAuthUrl(googlePage.url())) {
        return googlePage;
      }
    }

    if (isGoogleAuthUrl(fallbackPage.url())) {
      return fallbackPage;
    }

    await fallbackPage.waitForTimeout(500);
  }

  await logOpenPages(context, "Google auth page not detected");
  await logPageFrames(fallbackPage);
  console.log("Google auth page was not detected automatically.");
  console.log("Continue manually in the browser if the Google page is already open.");
  return fallbackPage;
}

async function fillGoogleCredentials(page) {
  if (!googleEmail && !googlePassword) {
    console.log(`No Google credentials found for account slot ${selectedAccount}. Continue manually.`);
    return;
  }

  if (googleEmail) {
    await fillGoogleEmail(page, googleEmail);
  }

  if (googlePassword) {
    await fillGooglePassword(page, googlePassword);
  }
}

function getGoogleCredentials(account) {
  const upperAccount = account.toUpperCase();
  const email =
    process.env[`RAPIDAPI_ACCOUNT_${upperAccount}_EMAIL`] ?? process.env.RAPIDAPI_GOOGLE_EMAIL;
  const password =
    process.env[`RAPIDAPI_ACCOUNT_${upperAccount}_PASSWORD`] ??
    process.env.RAPIDAPI_GOOGLE_PASSWORD;

  return {
    googleEmail: email,
    googlePassword: password,
  };
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
  } catch (error) {
    console.log("Could not import saved cookies into visible browser profile.");
    console.log(error instanceof Error ? error.message : error);
  }
}

async function needsSignIn(page) {
  if (page.url().includes("/auth/sign-in")) {
    return true;
  }

  try {
    const googleLoginCount = await page.getByText(/continue with google|sign in with google/i).count();
    return googleLoginCount > 0;
  } catch {
    return false;
  }
}

async function fillGoogleEmail(page, email) {
  try {
    const emailInput = page.locator('input[type="email"], input[name="identifier"]').first();
    await emailInput.waitFor({ state: "visible", timeout: 20_000 });
    await emailInput.fill(email);
    await clickGoogleNext(page, "identifierNext");
    await dismissInterruptions(page);
    console.log("Filled Google email.");
  } catch (error) {
    if (error instanceof Error && error.message === "CHALLENGE_SKIPPED") {
      throw error;
    }
    console.log("Could not auto-fill Google email. Continue manually.");
    console.log(error instanceof Error ? error.message : error);
  }
}

async function fillGooglePassword(page, password) {
  try {
    const passwordInput = page.locator('input[type="password"], input[name="Passwd"]').first();
    await passwordInput.waitFor({ state: "visible", timeout: 30_000 });
    await passwordInput.fill(password);
    await clickGoogleNext(page, "passwordNext");
    await dismissInterruptions(page);
    await handleGooglePostLoginPrompts(page);
    console.log("Filled Google password.");
  } catch (error) {
    if (error instanceof Error && error.message === "CHALLENGE_SKIPPED") {
      throw error;
    }
    console.log("Could not auto-fill Google password. Continue manually.");
    console.log(error instanceof Error ? error.message : error);
    await waitForManualGoogleChallenge(page);
  }
}

async function clickGoogleNext(page, id) {
  const nextById = page.locator(`#${id}`).first();
  if (await nextById.count()) {
    await nextById.click();
    return;
  }

  await page.getByRole("button", { name: /next|lanjut/i }).first().click();
}

async function waitForRapidApiAfterLogin(context, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const rapidApiPage = context.pages().find((openPage) => {
      const href = openPage.url();
      return href.includes("rapidapi.com") && !href.includes("/auth/sign-in");
    });

    if (rapidApiPage) {
      await rapidApiPage.bringToFront();
      return rapidApiPage;
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error("Timed out waiting for RapidAPI to finish login.");
}

async function subscribeAndExtractKey(page, context) {
  page.setDefaultTimeout(10_000);

  console.log(`Opening pricing page: ${pricingUrl}`);
  await page.bringToFront();
  if (!page.url().startsWith(pricingUrl)) {
    await page.goto(pricingUrl, { waitUntil: "domcontentloaded" });
  }
  await waitForDomReady(page);
  await dismissInterruptions(page);

  if (await isAlreadySubscribed(page)) {
    console.log("Account already has an active plan. Skipping subscription buttons.");
    return await openApiPageAndExtractKey(page, context);
  }

  await clickAction(page, "Start Free Plan", [
    page.getByRole("button", { name: /start free plan/i }),
    page.getByRole("link", { name: /start free plan/i }),
    page.getByText(/start free plan/i),
  ]);

  await waitForDomReady(page);
  await dismissInterruptions(page);
  if (await handleRapidApiLoginModal(page, context)) {
    await context.storageState({ path: storageStatePath });
    console.log(`Updated login state for account slot ${selectedAccount}: ${storageStatePath}`);
    await page.bringToFront();
    await page.goto(pricingUrl, { waitUntil: "domcontentloaded" });
    await waitForDomReady(page);
    await dismissInterruptions(page);
    if (await isAlreadySubscribed(page)) {
      console.log("Account already has an active plan after login.");
      return await openApiPageAndExtractKey(page, context);
    }
    await clickAction(page, "Start Free Plan", [
      page.getByRole("button", { name: /start free plan/i }),
      page.getByRole("link", { name: /start free plan/i }),
      page.getByText(/start free plan/i),
    ]);
    await waitForDomReady(page);
    await dismissInterruptions(page);
  }

  if (await handleRapidApiLoginModal(page, context, 8_000)) {
    await context.storageState({ path: storageStatePath });
    console.log(`Updated login state for account slot ${selectedAccount}: ${storageStatePath}`);
    await page.bringToFront();
    await page.goto(pricingUrl, { waitUntil: "domcontentloaded" });
    await waitForDomReady(page);
    await dismissInterruptions(page);
    if (await isAlreadySubscribed(page)) {
      console.log("Account already has an active plan after login.");
      return await openApiPageAndExtractKey(page, context);
    }
    await clickAction(page, "Start Free Plan", [
      page.getByRole("button", { name: /start free plan/i }),
      page.getByRole("link", { name: /start free plan/i }),
      page.getByText(/start free plan/i),
    ]);
    await waitForDomReady(page);
    await dismissInterruptions(page);
  }

  await clickSubscribeWithLoginRecovery(page, context);

  await waitForDomReady(page);
  await dismissInterruptions(page);

  await clickAction(page, "Get Started", [
    page.getByRole("button", { name: /get started/i }),
    page.getByRole("link", { name: /get started/i }),
    page.getByText(/get started/i),
  ]);

  await waitForDomReady(page);
  await dismissInterruptions(page);
  return await openApiPageAndExtractKey(page, context);
}

async function isAlreadySubscribed(page) {
  return await hasVisibleText(page, /cancel plan|current plan|manage subscription/i);
}

async function clickSubscribeWithLoginRecovery(page, context) {
  const subscribeLocators = [
    page.getByRole("button", { name: /^subscribe$/i }),
    page.getByRole("button", { name: /\bsubscribe\b/i }),
    page.getByRole("link", { name: /^subscribe$/i }),
    page.getByRole("link", { name: /\bsubscribe\b/i }),
    page.getByText(/\bsubscribe\b/i),
  ];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await clickAction(page, "Subscribe", subscribeLocators);
      return;
    } catch (error) {
      const hasLoginModal = await waitForRapidApiLoginModal(page, 2_000);
      if (!hasLoginModal || attempt === 2) {
        throw error;
      }

      console.log("Subscribe was blocked by a late RapidAPI login modal. Signing in and retrying.");
      await handleRapidApiLoginModal(page, context);
      await context.storageState({ path: storageStatePath });
      console.log(`Updated login state for account slot ${selectedAccount}: ${storageStatePath}`);
      await page.bringToFront();
      await page.goto(pricingUrl, { waitUntil: "domcontentloaded" });
      await waitForDomReady(page);
      await dismissInterruptions(page);
      if (await isAlreadySubscribed(page)) {
        console.log("Account already has an active plan after login.");
        return;
      }

      await clickAction(page, "Start Free Plan", [
        page.getByRole("button", { name: /start free plan/i }),
        page.getByRole("link", { name: /start free plan/i }),
        page.getByText(/start free plan/i),
      ]);
      await waitForDomReady(page);
      await dismissInterruptions(page);
    }
  }
}

async function openApiPageAndExtractKey(page, context) {
  console.log(`Opening API page: ${apiUrl}`);
  await page.goto(apiUrl, { waitUntil: "domcontentloaded" });
  await waitForDomReady(page);
  await dismissInterruptions(page);

  await clickOptional(
    page,
    [
      page.getByRole("button", { name: /dismiss notification/i }),
      page.getByText(/dismiss notification/i),
    ],
    "Dismissed notification",
  );

  const clickedAuthorization = await clickActionOptional(page, "Authorization", [
    page.getByRole("tab", { name: /authorization/i }),
    page.getByRole("button", { name: /authorization/i }),
    page.getByRole("link", { name: /authorization/i }),
    page.getByText(/authorization/i),
  ]);

  if (!clickedAuthorization) {
    await clickAction(page, "Open playground", [
      page.getByRole("link", { name: /open playground/i }),
      page.getByRole("button", { name: /open playground/i }),
      page.getByText(/open playground/i),
    ]);
    await waitForDomReady(page);
    await dismissInterruptions(page);

    await clickAction(page, "Authorization", [
      page.getByRole("tab", { name: /authorization/i }),
      page.getByRole("button", { name: /authorization/i }),
      page.getByRole("link", { name: /authorization/i }),
      page.getByText(/authorization/i),
    ]);
  }

  await waitForDomReady(page);
  await dismissInterruptions(page);

  await waitForRapidApiKeyToAppear(context, keyTimeoutMs);

  const key = await extractRapidApiKey(context);
  if (!key) {
    await logVisibleActions(page);
    throw new Error("Could not find X-RapidAPI-Key value after opening API page.");
  }

  return key;
}

async function clickAction(page, text, locators = []) {
  console.log(`Clicking: ${text}`);

  const clickedByLocator = await clickFirstVisible(page, locators);
  if (clickedByLocator) {
    console.log(`Clicked: ${text}`);
    return;
  }

  const clickedByText = await clickElementByText(page, text);
  if (clickedByText) {
    console.log(`Clicked by DOM text: ${text}`);
    return;
  }

  const clickedByCoordinates = await clickElementCenterByText(page, text);
  if (clickedByCoordinates) {
    console.log(`Clicked by coordinates: ${text}`);
    return;
  }

  await logVisibleActions(page);
  throw new Error(`Could not find action button: ${text}`);
}

async function clickActionOptional(page, text, locators = []) {
  console.log(`Clicking if available: ${text}`);

  const clickedByLocator = await clickFirstVisible(page, locators);
  if (clickedByLocator) {
    console.log(`Clicked: ${text}`);
    return true;
  }

  const clickedByText = await clickElementByText(page, text);
  if (clickedByText) {
    console.log(`Clicked by DOM text: ${text}`);
    return true;
  }

  const clickedByCoordinates = await clickElementCenterByText(page, text);
  if (clickedByCoordinates) {
    console.log(`Clicked by coordinates: ${text}`);
    return true;
  }

  console.log(`Not available yet: ${text}`);
  return false;
}

async function handleRapidApiLoginModal(page, context, waitMs = 0) {
  const hasGoogleLogin = await waitForRapidApiLoginModal(page, waitMs);
  if (!hasGoogleLogin) {
    return false;
  }

  console.log("RapidAPI login modal detected. Signing in with Google from modal.");
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null);
  await clickAction(page, "Login with Google", [
    page.getByRole("button", { name: /login with google|continue with google/i }),
    page.getByText(/login with google|continue with google/i),
  ]);
  const popup = await popupPromise;

  if (popup) {
    console.log(`Google popup detected: ${popup.url()}`);
    popup.setDefaultTimeout(20_000);
    await popup.bringToFront();
  }

  const authPage = popup && isGoogleAuthUrl(popup.url())
    ? popup
    : await waitForGoogleAuthPage(context, page);
  if (isGoogleAuthUrl(authPage.url())) {
    await fillGoogleCredentials(authPage);
  } else {
    console.log("Google credentials are already accepted; waiting for RapidAPI callback.");
  }

  console.log(`Waiting up to ${Math.round(timeoutMs / 1000)} seconds for RapidAPI login modal to finish...`);
  await waitForRapidApiLoginModalToClose(page, context, timeoutMs);
  await page.bringToFront();
  await waitForPageSettled(page);
  await dismissInterruptions(page);
  return true;
}

async function waitForRapidApiLoginModal(page, waitMs) {
  const deadline = Date.now() + waitMs;

  do {
    if (await hasVisibleText(page, /login with google|continue with google/i)) {
      return true;
    }

    if (waitMs <= 0) {
      return false;
    }

    await page.waitForTimeout(500);
  } while (Date.now() < deadline);

  return false;
}

async function logOpenPages(context, label) {
  console.log(`${label}. Open pages:`);
  for (const [index, openPage] of context.pages().entries()) {
    console.log(`- page ${index}: ${openPage.url()}`);
  }
}

async function logPageFrames(page) {
  try {
    console.log("Current page frames:");
    for (const [index, frame] of page.frames().entries()) {
      console.log(`- frame ${index}: ${frame.url()}`);
    }
  } catch {
    // Frame logging is debug-only.
  }
}

async function waitForRapidApiLoginModalToClose(page, context, timeout) {
  const deadline = Date.now() + timeout;
  const startedAt = Date.now();
  const refreshAfterMs = [15_000, 45_000, 90_000];
  let refreshAttempt = 0;

  while (Date.now() < deadline) {
    if (!(await hasVisibleText(page, /login with google|continue with google/i))) {
      return;
    }

    const elapsed = Date.now() - startedAt;
    if (refreshAttempt < refreshAfterMs.length && elapsed >= refreshAfterMs[refreshAttempt]) {
      refreshAttempt += 1;
      console.log("RapidAPI modal is still visible after Google auth. Refreshing pricing page.");
      await logOpenPages(context, "RapidAPI modal still visible");
      await page.bringToFront();
      await page.goto(pricingUrl, { waitUntil: "domcontentloaded" });
      await waitForDomReady(page);
      await dismissInterruptions(page);

      if (!(await hasVisibleText(page, /login with google|continue with google/i))) {
        return;
      }
    }

    await page.waitForTimeout(1_000);
  }

  await logOpenPages(context, "RapidAPI login modal timeout");
  await logVisibleActions(page);
  throw new Error("Timed out waiting for RapidAPI login modal to close.");
}

async function hasVisibleText(page, pattern) {
  try {
    return await page.evaluate((source) => {
      const regex = new RegExp(source, "i");
      const elements = [...document.querySelectorAll("button, a, [role='button'], div, span")];

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0
        );
      }

      return elements.some((element) => isVisible(element) && regex.test(element.textContent ?? ""));
    }, pattern.source);
  } catch {
    return false;
  }
}

async function clickFirstVisible(page, locators) {
  for (const locator of locators) {
    try {
      const first = locator.first();
      await first.waitFor({ state: "visible", timeout: 4_000 });
      await first.scrollIntoViewIfNeeded();
      await first.click({ timeout: 4_000 });
      return true;
    } catch {
      // Try the next locator; RapidAPI markup changes between pages and modals.
    }
  }

  return false;
}

async function clickElementByText(page, expectedText) {
  try {
    return await page.evaluate((text) => {
      const normalizedTarget = text.toLowerCase().replace(/\s+/g, " ").trim();
      const candidates = [
        ...document.querySelectorAll("button, a, [role='button'], [type='button'], [type='submit']"),
      ];

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0
        );
      }

      const element = candidates.find((candidate) => {
        const textContent = (candidate.textContent ?? "").toLowerCase().replace(/\s+/g, " ").trim();
        return isVisible(candidate) && textContent === normalizedTarget;
      });

      if (!element) {
        return false;
      }

      element.scrollIntoView({ block: "center", inline: "center" });
      element.click();
      return true;
    }, expectedText);
  } catch {
    return false;
  }
}

async function clickElementCenterByText(page, expectedText) {
  try {
    const box = await page.evaluate((text) => {
      const normalizedTarget = text.toLowerCase().replace(/\s+/g, " ").trim();
      const candidates = [
        ...document.querySelectorAll("button, a, [role='button'], [type='button'], [type='submit']"),
      ];

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0
        );
      }

      const element = candidates.find((candidate) => {
        const textContent = (candidate.textContent ?? "").toLowerCase().replace(/\s+/g, " ").trim();
        return isVisible(candidate) && textContent === normalizedTarget;
      });

      if (!element) {
        return null;
      }

      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    }, expectedText);

    if (!box) {
      return false;
    }

    await page.mouse.click(box.x, box.y);
    return true;
  } catch {
    return false;
  }
}

async function logVisibleActions(page) {
  try {
    const actions = await page.evaluate(() => {
      const elements = [
        ...document.querySelectorAll("button, a, [role='button'], [type='button'], [type='submit']"),
      ];

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0
        );
      }

      return elements
        .filter(isVisible)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role"),
          text: (element.textContent ?? "").replace(/\s+/g, " ").trim(),
          aria: element.getAttribute("aria-label"),
          className: element.getAttribute("class"),
        }))
        .filter((item) => item.text || item.aria)
        .slice(0, 80);
    });

    console.log("Visible actions on current page:");
    for (const action of actions) {
      console.log(
        `- ${action.tag}${action.role ? `[role=${action.role}]` : ""}: ${
          action.text || action.aria
        }`,
      );
    }
  } catch (error) {
    console.log("Could not inspect visible actions.");
    console.log(error instanceof Error ? error.message : error);
  }
}

async function dismissInterruptions(page) {
  if (page.url().includes("rapidapi.com")) {
    await clickOptional(
      page,
      [
        page.getByRole("button", { name: /reject all/i }),
        page.getByText(/reject all/i),
      ],
      "Rejected cookie modal",
    );
  }

  if (!isGoogleAuthUrl(page.url())) {
    return;
  }

  if (await isManualGoogleChallenge(page)) {
    await waitForManualGoogleChallenge(page);
    return;
  }

  await clickOptional(
    page,
    [
      page.getByRole("button", { name: /i understand/i }),
      page.getByText(/i understand/i),
    ],
    "Clicked I understand",
  );

  await clickOptional(
    page,
    [
      page.getByRole("button", { name: /continue/i }),
      page.getByRole("button", { name: /confirm/i }),
      page.getByRole("button", { name: /yes,? i'?m in/i }),
      page.getByRole("button", { name: /not now/i }),
    ],
    "Clicked optional Google prompt button",
  );
}

async function handleGooglePostLoginPrompts(page) {
  const deadline = Date.now() + 45_000;

  while (Date.now() < deadline && isGoogleAuthUrl(page.url())) {
    if (await isManualGoogleChallenge(page)) {
      await waitForManualGoogleChallenge(page);
      return;
    }

    const clicked = await clickOptional(
      page,
      [
        page.getByRole("button", { name: /i understand/i }),
        page.getByRole("button", { name: /continue/i }),
        page.getByRole("button", { name: /confirm/i }),
        page.getByRole("button", { name: /next/i }),
        page.getByRole("button", { name: /lanjut/i }),
        page.getByText(/i understand/i),
      ],
      "Handled Google prompt",
    );

    if (!clicked) {
      const clickedBlueButton = await clickGoogleBlueButton(page);
      if (clickedBlueButton) {
        await page.waitForTimeout(1_000);
        continue;
      }

      await page.waitForTimeout(1_000);
    }
  }
}

async function waitForManualGoogleChallenge(page) {
  if (!isGoogleAuthUrl(page.url())) {
    return;
  }

  const filledPassword = await fillVisibleGooglePasswordOnly(page);
  if (filledPassword) {
    await clickGoogleChallengeSubmit(page);
    await page.waitForTimeout(1_000);
  }

  if (!(await hasVisibleCaptchaChallenge(page))) {
    return;
  }

  console.log("Manual Google challenge detected. Sending full screenshot to Telegram and waiting for a reply.");
  const telegramReplyOffset = await getTelegramNextUpdateOffset();
  await notifyTelegram(
    `RapidAPI account ${selectedAccount} butuh verifikasi Google. Balas pesan ini dengan jawaban CAPTCHA/challenge saja; script akan coba isi ke kolom yang terlihat.`,
  );
  await notifyTelegramScreenshot(
    page,
    `RapidAPI account ${selectedAccount}: screenshot full halaman challenge Google. Balas dengan jawaban CAPTCHA/challenge saja.`,
    { redact: false },
  );
  if (skipChallenge) {
    console.log("Challenge skip mode enabled. Closing this account and continuing batch.");
    throw new Error("CHALLENGE_SKIPPED");
  }
  const deadline = Date.now() + timeoutMs;
  let nextUpdateOffset = telegramReplyOffset;
  let lastChallengeReply = "";

  while (Date.now() < deadline && isGoogleAuthUrl(page.url())) {
    if (!(await hasVisibleCaptchaChallenge(page))) {
      console.log("Google CAPTCHA is no longer visible. Continuing normal Google prompt automation.");
      return;
    }

    await fillVisibleGooglePasswordOnly(page);
    const reply = await pollTelegramChallengeReply(nextUpdateOffset);
    nextUpdateOffset = reply.nextOffset;

    if (reply.text) {
      console.log("Received Telegram challenge reply. Trying to fill visible challenge input.");
      const filled = await fillVisibleChallengeAnswer(page, reply.text);
      if (filled) {
        lastChallengeReply = reply.text;
        await notifyTelegram(`RapidAPI account ${selectedAccount}: jawaban challenge sudah diisi.`);
        await clickGoogleChallengeSubmit(page);
        await page.waitForTimeout(2_000);
        if (await hasVisibleCaptchaChallenge(page)) {
          console.log("Google CAPTCHA is still visible after submit. Sending a fresh screenshot.");
          lastChallengeReply = "";
          await notifyTelegramScreenshot(
            page,
            `RapidAPI account ${selectedAccount}: CAPTCHA masih muncul setelah jawaban sebelumnya. Balas dengan jawaban baru saja.`,
            { redact: false },
          );
        }
      } else {
        await notifyTelegram(
          `RapidAPI account ${selectedAccount}: balasan diterima, tapi kolom challenge teks belum terlihat. Browser tetap menunggu.`,
        );
      }
    } else if (lastChallengeReply && (await hasVisibleCaptchaError(page))) {
      console.log("Google CAPTCHA shows an error. Sending a fresh screenshot.");
      lastChallengeReply = "";
      await notifyTelegramScreenshot(
        page,
        `RapidAPI account ${selectedAccount}: jawaban CAPTCHA ditolak. Balas dengan jawaban baru saja.`,
        { redact: false },
      );
    }

    await page.waitForTimeout(telegramPollMs);
  }
}

async function fillVisibleChallengeAnswer(page, answer) {
  if (!answer || !isGoogleAuthUrl(page.url())) {
    return false;
  }

  const selectors = [
    "input[type='text']",
    "input:not([type])",
    "input[type='tel']",
    "textarea",
  ];

  for (const selector of selectors) {
    const inputs = page.locator(selector);
    const count = await inputs.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      try {
        if (!(await input.isVisible({ timeout: 500 }))) {
          continue;
        }

        if (!(await input.isEnabled({ timeout: 500 }))) {
          continue;
        }

        const meta = await input.evaluate((element) => ({
          type: (element.getAttribute("type") ?? "").toLowerCase(),
          name: (element.getAttribute("name") ?? "").toLowerCase(),
          autocomplete: (element.getAttribute("autocomplete") ?? "").toLowerCase(),
          aria: (element.getAttribute("aria-label") ?? "").toLowerCase(),
          id: (element.getAttribute("id") ?? "").toLowerCase(),
          value: "value" in element ? element.value : "",
        }));

        const joined = `${meta.type} ${meta.name} ${meta.autocomplete} ${meta.aria} ${meta.id}`;
        if (/email|identifier|password|passwd|search/.test(joined)) {
          continue;
        }

        if (meta.value && meta.value.trim() !== answer.trim()) {
          continue;
        }

        await input.fill(answer, { timeout: 2_000 });
        console.log("Filled visible Google challenge input from Telegram reply.");
        return true;
      } catch {
        // Try the next visible text field.
      }
    }
  }

  return false;
}

async function fillVisibleGooglePasswordOnly(page) {
  if (!googlePassword || !isGoogleAuthUrl(page.url())) {
    return false;
  }

  try {
    const passwordInput = page.locator('input[type="password"], input[name="Passwd"]').first();
    if ((await passwordInput.count()) === 0) {
      return false;
    }

    if (!(await passwordInput.isVisible({ timeout: 500 }))) {
      return false;
    }

    const currentValue = await passwordInput.inputValue().catch(() => "");
    if (currentValue) {
      return false;
    }

    await passwordInput.fill(googlePassword, { timeout: 2_000 });
    console.log("Filled Google password for visible Google prompt.");
    return true;
  } catch {
    return false;
  }
}

async function isManualGoogleChallenge(page) {
  if (!isGoogleAuthUrl(page.url())) {
    return false;
  }

  return await hasVisibleCaptchaChallenge(page);
}

async function hasVisibleCaptchaChallenge(page) {
  if (!isGoogleAuthUrl(page.url())) {
    return false;
  }

  try {
    return await page.evaluate(() => {
      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      }

      const captchaFrameSelectors = [
        "iframe[src*='recaptcha']",
        "iframe[src*='captcha']",
        "iframe[title*='recaptcha' i]",
        "iframe[title*='captcha' i]",
      ];

      const hasActionableCaptchaFrame = captchaFrameSelectors.some((selector) =>
        [...document.querySelectorAll(selector)].some((element) => {
          if (!isVisible(element)) {
            return false;
          }

          const rect = element.getBoundingClientRect();
          const minSize = rect.width >= 250 && rect.height >= 70;
          const notBadgePosition =
            rect.top < window.innerHeight - 100 && rect.left < window.innerWidth - 100;
          return minSize && notBadgePosition;
        }),
      );

      const bodyText = (document.body?.innerText ?? document.body?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const hasCaptchaText =
        /i'?m not a robot|not a robot|select all images|select all squares|unusual traffic|type the text|enter the text|characters you see|captcha challenge/i.test(
          bodyText,
        );

      const hasChallengeInput = [...document.querySelectorAll("input, textarea")].some((element) => {
        if (!isVisible(element) || element.disabled || element.readOnly) {
          return false;
        }

        const type = (element.getAttribute("type") ?? "text").toLowerCase();
        const name = (element.getAttribute("name") ?? "").toLowerCase();
        const id = (element.getAttribute("id") ?? "").toLowerCase();
        const aria = (element.getAttribute("aria-label") ?? "").toLowerCase();
        const placeholder = (element.getAttribute("placeholder") ?? "").toLowerCase();
        const meta = `${type} ${name} ${id} ${aria} ${placeholder}`;

        return (
          /text|tel|number/.test(type) &&
          /captcha|challenge|code|text|characters|answer/.test(meta) &&
          !/email|identifier|password|passwd|search/.test(meta)
        );
      });

      return hasChallengeInput || hasActionableCaptchaFrame || (hasCaptchaText && hasChallengeInput);
    });
  } catch {
    return false;
  }
}

async function hasVisibleCaptchaError(page) {
  if (!isGoogleAuthUrl(page.url())) {
    return false;
  }

  return await hasVisibleText(
    page,
    /incorrect|try again|couldn'?t verify|please enter the characters|enter the characters|characters you see/i,
  );
}

async function clickGoogleBlueButton(page) {
  if (!isGoogleAuthUrl(page.url())) {
    return false;
  }

  if (await isManualGoogleChallenge(page)) {
    return false;
  }

  try {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button, [role='button']")];

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
      }

      function isBlueAction(element) {
        const style = window.getComputedStyle(element);
        const color = style.backgroundColor.match(/\d+/g)?.map(Number) ?? [];
        const text = (element.textContent ?? "").trim();
        const [red = 255, green = 255, blue = 255] = color;

        return (
          isVisible(element) &&
          text.length > 0 &&
          blue > 120 &&
          blue > red + 30 &&
          blue >= green &&
          !/back|cancel/i.test(text)
        );
      }

      const button = buttons.find(isBlueAction);
      if (!button) {
        return false;
      }

      button.click();
      return true;
    });

    if (clicked) {
      console.log("Clicked Google blue prompt button");
      await waitForPageSettled(page);
      return true;
    }
  } catch {
    // Style-based fallback is best effort only.
  }

  return false;
}

async function clickGoogleChallengeSubmit(page) {
  if (!isGoogleAuthUrl(page.url())) {
    return false;
  }

  const clickedNamedButton = await clickOptional(
    page,
    [
      page.getByRole("button", { name: /next|lanjut|continue|verify|submit/i }),
      page.locator("#next").first(),
      page.locator("#identifierNext").first(),
      page.locator("#passwordNext").first(),
    ],
    "Submitted Google challenge answer",
  );
  if (clickedNamedButton) {
    return true;
  }

  try {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("button, [role='button']")];

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
      }

      const button = buttons.find((element) => {
        const text = (element.textContent ?? "").trim();
        const style = window.getComputedStyle(element);
        const color = style.backgroundColor.match(/\d+/g)?.map(Number) ?? [];
        const [red = 255, green = 255, blue = 255] = color;
        return (
          isVisible(element) &&
          text.length > 0 &&
          blue > 120 &&
          blue > red + 30 &&
          blue >= green &&
          !/back|cancel/i.test(text)
        );
      });

      if (!button) {
        return false;
      }

      button.click();
      return true;
    });

    if (clicked) {
      console.log("Submitted Google challenge with blue action button");
      await waitForPageSettled(page);
      return true;
    }
  } catch {
    // Best-effort submit; the loop will keep waiting if the page remains on challenge.
  }

  return false;
}

async function clickOptional(page, locators, message) {
  for (const locator of locators) {
    try {
      const first = locator.first();
      await first.waitFor({ state: "visible", timeout: 1_500 });
      await first.scrollIntoViewIfNeeded();
      await first.click();
      console.log(message);
      await waitForPageSettled(page);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "CHALLENGE_SKIPPED") {
        throw error;
      }
      // Optional prompt not present.
    }
  }

  return false;
}

async function waitForPageSettled(page) {
  await waitForDomReady(page);
}

async function waitForDomReady(page) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
  } catch {
    // RapidAPI can keep background requests open; target element checks continue below.
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRapidApiKeyToAppear(context, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await extractRapidApiKey(context)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
        for (let depth = 0; scope && depth < 6; depth += 1) {
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

      const bodyText = document.body?.innerText ?? document.body?.textContent ?? "";
      return fromText(bodyText);
    });

    if (key) {
      return key;
    }
  }

  return null;
}

function isGoogleAuthUrl(url) {
  return url.includes("accounts.google.com") || url.includes("google.com/signin");
}

async function isSignedIn(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: 10_000 });
  } catch {
    // The sign-in page can keep background requests open; DOM checks are enough here.
  }

  const signInText = await page.getByText(/sign in|log in/i).count();
  const dashboardLink = await page.getByRole("link", { name: /dashboard|my apps/i }).count();
  return dashboardLink > 0 && signInText === 0;
}

async function waitForEnter(message) {
  process.stdout.write(`${message}\n`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once("data", resolve));
}

async function notifyTelegram(message) {
  if (!telegramBotToken) {
    return;
  }

  try {
    const chatId = telegramChatId ?? (await resolveTelegramChatId());
    if (!chatId) {
      console.log("Telegram bot token is set, but chat id was not found. Send /start to the bot or set TELEGRAM_CHAT_ID.");
      return;
    }

    await sendTelegramMessage(chatId, message);
  } catch (error) {
    console.log("Could not send Telegram notification.");
    console.log(error instanceof Error ? error.message : error);
  }
}

async function notifyTelegramScreenshot(page, caption, options = {}) {
  if (!telegramBotToken) {
    return;
  }

  let screenshot = null;
  let shouldRedact = true;

  try {
    const chatId = telegramChatId ?? (await resolveTelegramChatId());
    if (!chatId) {
      return;
    }

    shouldRedact = options.redact ?? true;
    if (shouldRedact) {
      await redactChallengeContent(page);
    }
    screenshot = await page.screenshot({
      fullPage: true,
      type: "png",
      timeout: 10_000,
    });
    if (shouldRedact) {
      await removeScreenshotRedactions(page);
    }

    await sendTelegramPhoto(chatId, caption, screenshot);
  } catch (error) {
    console.log("Could not send Telegram screenshot.");
    console.log(error instanceof Error ? error.message : error);

    if (screenshot) {
      const fallbackPath = await saveTelegramScreenshotFallback(screenshot);
      console.log(`telegram_screenshot_fallback=${fallbackPath}`);
      try {
        const chatId = telegramChatId ?? (await resolveTelegramChatId());
        if (chatId) {
          await sendTelegramMessage(
            chatId,
            `${caption}\n\nGagal kirim foto ke Telegram setelah retry. Screenshot tersimpan lokal: ${fallbackPath}`,
          );
        }
      } catch (fallbackError) {
        console.log("Could not send Telegram fallback path.");
        console.log(fallbackError instanceof Error ? fallbackError.message : fallbackError);
      }
    }
  } finally {
    if (shouldRedact) {
      await removeScreenshotRedactions(page);
    }
  }
}

async function sendTelegramMessage(chatId, message) {
  await retryTelegramRequest(async () => {
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
    }
  });
}

async function sendTelegramPhoto(chatId, caption, screenshot) {
  await retryTelegramRequest(async () => {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("caption", caption);
    form.append("photo", new Blob([screenshot], { type: "image/png" }), `rapidapi-account-${selectedAccount}.png`);

    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendPhoto`, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Telegram sendPhoto failed: ${response.status} ${await response.text()}`);
    }
  });
}

async function retryTelegramRequest(send) {
  let lastError;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await send();
      return;
    } catch (error) {
      lastError = error;
      console.log(`Telegram request failed attempt ${attempt}/4.`);
      console.log(error instanceof Error ? error.message : error);
      await sleep(750 * attempt);
    }
  }

  throw lastError;
}

async function saveTelegramScreenshotFallback(screenshot) {
  const outputDir = path.resolve("output", "telegram-fallback");
  await mkdir(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(outputDir, `rapidapi-account-${selectedAccount}-${stamp}.png`);
  await writeFile(filePath, screenshot);
  return filePath;
}

async function getTelegramNextUpdateOffset() {
  if (!telegramBotToken) {
    return null;
  }

  try {
    const updates = await fetchTelegramUpdates();
    const latestId = updates
      .map((update) => update.update_id)
      .filter((id) => Number.isInteger(id))
      .at(-1);
    return Number.isInteger(latestId) ? latestId + 1 : null;
  } catch {
    return null;
  }
}

async function pollTelegramChallengeReply(offset) {
  const result = {
    text: null,
    nextOffset: offset,
  };

  if (!telegramBotToken) {
    return result;
  }

  try {
    const chatId = telegramChatId ?? (await resolveTelegramChatId());
    if (!chatId) {
      return result;
    }

    const updates = await fetchTelegramUpdates(offset);
    for (const update of updates) {
      if (Number.isInteger(update.update_id)) {
        result.nextOffset = update.update_id + 1;
      }

      const message = update.message ?? update.edited_message;
      if (!message || String(message.chat?.id) !== String(chatId)) {
        continue;
      }

      const text = (message.text ?? message.caption ?? "").trim();
      if (!text || text.startsWith("/")) {
        continue;
      }

      result.text = text.slice(0, 512);
    }
  } catch (error) {
    console.log("Could not poll Telegram challenge reply.");
    console.log(error instanceof Error ? error.message : error);
  }

  return result;
}

async function fetchTelegramUpdates(offset) {
  const params = new URLSearchParams({
    timeout: "0",
    allowed_updates: JSON.stringify(["message", "edited_message", "channel_post"]),
  });
  if (Number.isInteger(offset)) {
    params.set("offset", String(offset));
  }

  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/getUpdates?${params}`);
  const payload = await response.json();
  return Array.isArray(payload.result) ? payload.result : [];
}

async function redactChallengeContent(page) {
  try {
    await page.evaluate(() => {
      const selectors = [
        "input[type='password']",
        "iframe[src*='recaptcha']",
        "iframe[src*='captcha']",
        "iframe[title*='recaptcha' i]",
        "iframe[title*='captcha' i]",
        "[class*='captcha' i]",
        "[id*='captcha' i]",
        "[aria-label*='captcha' i]",
      ];

      const elements = new Set();
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          elements.add(element);
        }
      }

      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          continue;
        }

        const redaction = document.createElement("div");
        redaction.textContent = "REDACTED";
        redaction.style.position = "fixed";
        redaction.style.left = `${rect.left}px`;
        redaction.style.top = `${rect.top}px`;
        redaction.style.width = `${rect.width}px`;
        redaction.style.height = `${rect.height}px`;
        redaction.style.zIndex = "2147483647";
        redaction.style.background = "#111827";
        redaction.style.color = "#ffffff";
        redaction.style.display = "flex";
        redaction.style.alignItems = "center";
        redaction.style.justifyContent = "center";
        redaction.style.font = "700 14px sans-serif";
        redaction.style.border = "2px solid #ffffff";
        redaction.setAttribute("data-rapidapi-redaction", "true");
        document.body.appendChild(redaction);
      }
    });
  } catch {
    // Redaction is best-effort; screenshot sending should not crash the automation.
  }
}

async function removeScreenshotRedactions(page) {
  try {
    await page.evaluate(() => {
      for (const element of document.querySelectorAll("[data-rapidapi-redaction='true']")) {
        element.remove();
      }
    });
  } catch {
    // Best effort cleanup.
  }
}

async function resolveTelegramChatId() {
  if (!telegramBotToken) {
    return null;
  }

  try {
    const updates = await fetchTelegramUpdates();
    const latest = updates
      .map((update) => update.message?.chat?.id ?? update.channel_post?.chat?.id)
      .filter(Boolean)
      .at(-1);

    if (latest) {
      telegramChatId = String(latest);
      return telegramChatId;
    }
  } catch {
    return null;
  }

  return null;
}
