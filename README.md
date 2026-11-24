# whichonetheapis

Browser automation for signing in to RapidAPI with Google, opening the [Google Search API by herosAPI](https://rapidapi.com/herosAPI/api/google-search74), subscribing to the free plan when needed, and reading the account's `X-RapidAPI-Key` from the Authorization page.

The workflow uses a separate Playwright browser profile for each account. Google verification and RapidAPI checkout can require user input because their pages and prompts change over time.

## Requirements and setup

- Node.js 20 or newer
- npm
- Chromium for Playwright

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Add your login settings to the local `.env` file. The file is ignored by Git, along with browser profiles in `.auth/` and generated files in `output/`.

## Run one account

Add these entries to `.env`:

```dotenv
RAPIDAPI_ACCOUNT=1
RAPIDAPI_ACCOUNT_1_EMAIL=account@example.com
RAPIDAPI_GOOGLE_PASSWORD=your_google_password
RAPIDAPI_LOGIN_TIMEOUT_MS=180000
RAPIDAPI_KEY_TIMEOUT_MS=35000
```

Then run:

```bash
npm run login:rapidapi
```

`RAPIDAPI_ACCOUNT` selects the account number. To use a different password for that account, set `RAPIDAPI_ACCOUNT_1_PASSWORD`; otherwise, the script uses `RAPIDAPI_GOOGLE_PASSWORD`.

The browser is visible and stays open until you press Enter. Set `RAPIDAPI_AUTO_CLOSE=1` to close it when the run finishes. On Linux, `xvfb-run -a npm run login:rapidapi` runs the visible browser on a virtual display.

The complete key is printed in the terminal when extraction succeeds. Recorded terminal output may therefore contain the key. A Telegram success message shows only its last six characters.

## Google CAPTCHA and Telegram

To receive verification messages and screenshots, add:

```dotenv
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

Send `/start` to the bot from that chat before running the automation. If Google shows a text CAPTCHA, the script sends a screenshot to the Telegram bot and waits for your manual answer. Send the CAPTCHA text as a plain text message in the same chat. The script enters your answer and continues the automation. If Google asks again, the bot sends a new screenshot and waits for another answer. You can also complete verification directly in the browser.

`RAPIDAPI_LOGIN_TIMEOUT_MS` controls how long the login or challenge can wait (default: 180,000 ms). `RAPIDAPI_TELEGRAM_POLL_MS` controls how often the script checks Telegram for your reply (default: 3,000 ms). Keep the automation process running while you answer.

## Run multiple accounts

Add numbered email entries to `.env`:

```dotenv
RAPIDAPI_ACCOUNT_1_EMAIL=account1@example.com
RAPIDAPI_ACCOUNT_2_EMAIL=account2@example.com
RAPIDAPI_GOOGLE_PASSWORD=shared_google_password
```

Run every configured account, or select a range:

```bash
npm run login:rapidapi:all
RAPIDAPI_START_ACCOUNT=2 RAPIDAPI_END_ACCOUNT=10 npm run login:rapidapi:all
```

The batch runs one account at a time by default. Set `RAPIDAPI_CONCURRENCY` to increase parallelism. The batch closes each browser automatically and defaults to `RAPIDAPI_SKIP_CHALLENGE=1`: an account with a challenge is marked `CHALLENGE` and the batch moves on. **To wait for Telegram CAPTCHA replies during a batch**, run:

```bash
RAPIDAPI_SKIP_CHALLENGE=0 npm run login:rapidapi:all
```

For manual verification, running one account at a time is easier to follow:

```bash
RAPIDAPI_ACCOUNT=2 npm run login:rapidapi
```

The batch masks keys in its terminal summary and writes JSON and CSV results to `output/`. It does not write complete keys to a TXT file.

## Check progress and recover keys

Each browser run writes a state file to `output/automation-state/<run-id>/account-<number>.json`. It records the current stage, status, update time, last error, and key suffix after success. Inspect the latest run or a specific run ID:

```bash
npm run automation:status
npm run automation:status -- RUN_ID
```

Stages include `initialized`, `session_check`, `login_required`, `waiting_for_user`, `pricing_open`, `api_page_open`, `completed`, and `failed`. The state file is for observation; to retry an account, run `npm run login:rapidapi` with its account number again.

To extract complete keys from saved browser profiles into a TXT file after login, run:

```bash
node scripts/extract-rapidapi-keys.mjs
```

The default output path is `output/rapidapi-keys.txt`. Use `RAPIDAPI_START_ACCOUNT`, `RAPIDAPI_END_ACCOUNT`, or `RAPIDAPI_KEYS_OUTPUT` to change the account range or destination.

## Commands and local files

| Command or path | Purpose |
| --- | --- |
| `npm run login:rapidapi` | Sign in, subscribe, and read the key for one account |
| `npm run login:rapidapi:all` | Run the numbered accounts in `.env` |
| `npm run automation:status` | Show browser run states |
| `node scripts/extract-rapidapi-keys.mjs` | Read keys from saved profiles into a TXT file |
| `npm test` | Run local smoke tests without external login or API calls |
| `.auth/` | Per-account browser profiles and saved login state |
| `output/` | Run states, batch reports, and extracted key files |

Browser profiles, passwords, bot tokens, and extracted keys are local secrets. Keep them out of the repository when publishing it.
