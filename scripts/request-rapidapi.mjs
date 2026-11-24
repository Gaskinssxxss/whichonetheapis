import dotenv from "dotenv";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: npm run api:request -- [endpoint]

Set RAPIDAPI_API_KEY, RAPIDAPI_HOST, and RAPIDAPI_ENDPOINT in .env.
The endpoint argument overrides RAPIDAPI_ENDPOINT.
Optional: RAPIDAPI_METHOD, RAPIDAPI_QUERY_JSON, RAPIDAPI_BODY_JSON,
RAPIDAPI_REQUEST_TIMEOUT_MS, RAPIDAPI_ENV_FILE.
See README.md for examples.`);
  process.exit(0);
}

dotenv.config({ path: process.env.RAPIDAPI_ENV_FILE ?? ".env" });

const apiKey = process.env.RAPIDAPI_API_KEY?.trim();
const host = process.env.RAPIDAPI_HOST?.trim().toLowerCase();
const endpoint = process.argv[2] ?? process.env.RAPIDAPI_ENDPOINT;
const method = (process.env.RAPIDAPI_METHOD ?? "GET").trim().toUpperCase();
const timeoutMs = Number(process.env.RAPIDAPI_REQUEST_TIMEOUT_MS ?? "30000");

if (!apiKey || !host || !endpoint) {
  console.error("Set RAPIDAPI_API_KEY, RAPIDAPI_HOST, and RAPIDAPI_ENDPOINT in .env.");
  process.exit(1);
}

if (!/^[a-z0-9.-]+$/i.test(host) || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
  console.error("RAPIDAPI_HOST must be a hostname, such as example-api.p.rapidapi.com.");
  process.exit(1);
}

if (!/^https?:\/\//i.test(endpoint) && !endpoint.startsWith("/")) {
  console.error("RAPIDAPI_ENDPOINT must start with / or be a complete URL.");
  process.exit(1);
}

let url;
try {
  url = /^https?:\/\//i.test(endpoint)
    ? new URL(endpoint)
    : new URL(endpoint, `https://${host}`);
} catch {
  console.error("RAPIDAPI_ENDPOINT is not a valid URL or path.");
  process.exit(1);
}

if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) {
  console.error("The endpoint URL must use RAPIDAPI_HOST.");
  process.exit(1);
}

if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method)) {
  console.error("RAPIDAPI_METHOD must be GET, HEAD, POST, PUT, PATCH, or DELETE.");
  process.exit(1);
}

if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
  console.error("RAPIDAPI_REQUEST_TIMEOUT_MS must be between 1000 and 300000.");
  process.exit(1);
}

let query = {};
let body;
try {
  query = JSON.parse(process.env.RAPIDAPI_QUERY_JSON || "{}");
  if (!query || Array.isArray(query) || typeof query !== "object") {
    throw new Error("query must be a JSON object");
  }

  if (process.env.RAPIDAPI_BODY_JSON?.trim()) {
    body = JSON.parse(process.env.RAPIDAPI_BODY_JSON);
  }
} catch (error) {
  console.error(`Invalid RapidAPI JSON config: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

for (const [key, value] of Object.entries(query)) {
  for (const item of Array.isArray(value) ? value : [value]) {
    if (item !== null && item !== undefined) {
      if (!["string", "number", "boolean"].includes(typeof item) || (typeof item === "number" && !Number.isFinite(item))) {
        console.error(`RAPIDAPI_QUERY_JSON value for ${key} must be a string, number, boolean, or an array of these.`);
        process.exit(1);
      }
      url.searchParams.append(key, String(item));
    }
  }
}

const headers = {
  "X-RapidAPI-Key": apiKey,
  "X-RapidAPI-Host": host,
  Accept: "application/json",
};

const requestOptions = {
  method,
  headers,
  signal: AbortSignal.timeout(timeoutMs),
  redirect: "manual",
};
if (body !== undefined) {
  if (method === "GET" || method === "HEAD") {
    console.error(`${method} requests cannot use RAPIDAPI_BODY_JSON.`);
    process.exit(1);
  }
  headers["content-type"] = "application/json";
  requestOptions.body = JSON.stringify(body);
}

try {
  const response = await fetch(url, requestOptions);
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`HTTP ${response.status} redirect. Check RAPIDAPI_HOST and RAPIDAPI_ENDPOINT.`);
  }
  const responseText = await response.text();
  let output = responseText;

  try {
    output = JSON.stringify(JSON.parse(responseText), null, 2);
  } catch {
    // Keep non-JSON API responses readable as text.
  }

  console.log(`HTTP ${response.status} ${response.statusText}`);
  if (output) {
    console.log(output);
  }

  if (!response.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`RapidAPI request failed: ${error instanceof Error && error.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : message}`);
  process.exitCode = 1;
}
