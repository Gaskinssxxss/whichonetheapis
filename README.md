# whichonetheapis

A collection of Node.js tools for working with RapidAPI. The repository contains two separate tool groups:

- `api:request`: sends HTTP requests to a selected RapidAPI API using one API key.
- Legacy browser scripts: an account workflow configured for the existing RapidAPI Football Stats setup in `scripts/login-rapidapi-google.mjs`.

Use `api:request` to call other RapidAPI APIs. Each API has its own host, endpoint, parameters, and request body; follow the documentation for the API you select.

## Setup

```bash
git clone REPO_URL
cd whichonetheapis
npm install
cp .env.example .env
```

Set your local configuration in `.env`. Do not commit that file. `.gitignore` excludes `.env`, related environment files, `.auth/`, `output/`, `node_modules/`, and `*.key` / `*.pem` files. `.env.example` is a template and contains no active credentials.

## Make an API Request

Set the host, path, and key for the API you want to use:

```dotenv
RAPIDAPI_API_KEY=YOUR_RAPIDAPI_KEY
RAPIDAPI_HOST=example-api.p.rapidapi.com
RAPIDAPI_ENDPOINT=/v1/example
RAPIDAPI_METHOD=GET
RAPIDAPI_QUERY_JSON={"limit":10}
RAPIDAPI_BODY_JSON=
```

Run the request:

```bash
npm run api:request
```

You can pass the endpoint as an argument while keeping the host and key in `.env`:

```bash
npm run api:request -- /v1/another-resource
```

For `POST`, `PUT`, or `PATCH` requests, set the method and JSON body:

```dotenv
RAPIDAPI_METHOD=POST
RAPIDAPI_BODY_JSON={"name":"sample"}
```

The script sends the `X-RapidAPI-Key` and `X-RapidAPI-Host` headers, adds query parameters from `RAPIDAPI_QUERY_JSON`, and prints the HTTP status and response. It does not print the API key. A complete endpoint URL passed as an argument must use the same host as `RAPIDAPI_HOST`.

### Request Variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `RAPIDAPI_API_KEY` | API key from your RapidAPI dashboard | Required |
| `RAPIDAPI_HOST` | API host, such as `example-api.p.rapidapi.com` | Required |
| `RAPIDAPI_ENDPOINT` | Endpoint path, such as `/v1/example` | Required unless passed as an argument |
| `RAPIDAPI_METHOD` | HTTP method | `GET` |
| `RAPIDAPI_QUERY_JSON` | JSON object used for query parameters | `{}` |
| `RAPIDAPI_BODY_JSON` | JSON request body | Empty |

Refer to the selected API's RapidAPI documentation for parameter names, data formats, and valid endpoints.

## Other Scripts

- `scripts/request-rapidapi.mjs`: generic API request script used by `npm run api:request`.
- `scripts/login-rapidapi-google.mjs`: browser account workflow configured specifically for the existing RapidAPI/Football Stats setup.
- `scripts/run-all-rapidapi-accounts.mjs`: batch runner for the legacy browser workflow. It reads account entries from environment variables and writes a summary to `output/`.
- `scripts/extract-rapidapi-keys.mjs` and `scripts/collect-full-keys-via-login.mjs`: legacy helpers that read keys from saved browser profiles. They are separate from the generic API request tool.

The browser workflow uses Playwright and saves profile/state data in `.auth/`. Browser profiles and generated files in `output/` are local and are not included when cloning from GitHub. Install the browser if you need that specialized workflow:

```bash
npx playwright install chromium
```

The legacy browser workflow uses variables such as `RAPIDAPI_ACCOUNT_*`, `RAPIDAPI_GOOGLE_PASSWORD`, and the Telegram options listed in `.env.example`. Changes to filenames, API URLs, or login flow may require corresponding script changes. These settings do not change the target of the generic API request tool.

## Using the Repo on Another Device

1. Clone the repository and run `npm install`.
2. Copy `.env.example` to `.env`.
3. Add the API key and API configuration to the local `.env` file.
4. Run `npm run api:request`.

Keys stored in `output/rapidapi-keys.txt` on the source device are not pushed because Git ignores the entire `output/` directory. Transfer keys separately using your preferred secrets storage, then add them to `.env` on the destination device. Do not put active keys in this README, source code, or Git commits.
