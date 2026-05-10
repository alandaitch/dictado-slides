import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_SKEW_MS = 120_000;

function authPath(env = process.env) {
  return join((env.CODEX_HOME || join(homedir(), ".codex")).trim(), "auth.json");
}

function decodeJwt(token) {
  if (typeof token !== "string" || token.split(".").length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

function parsePayload(payload) {
  const tokens = payload?.tokens;
  if (!tokens?.access_token || !tokens?.refresh_token) return undefined;
  const claims = decodeJwt(tokens.access_token);
  const accountId =
    payload.account_id ||
    claims?.chatgpt_account_id ||
    claims?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  return { tokens, accountId };
}

function writePayload(path, payload) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

async function refreshTokens(tokens) {
  const res = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`Codex token refresh failed (${res.status}). Run \`codex\` and sign in.`);
  }
  const body = await res.json();
  return {
    ...tokens,
    access_token: body.access_token,
    refresh_token: body.refresh_token || tokens.refresh_token,
  };
}

export function readAuthSync(env = process.env) {
  const path = authPath(env);
  if (!existsSync(path)) return undefined;
  try {
    return parsePayload(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return undefined;
  }
}

export async function resolveCredentials(env = process.env) {
  const path = authPath(env);
  if (!existsSync(path)) {
    throw new Error(`No existe ${path}. Corré \`codex\` y logueate con ChatGPT.`);
  }
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const auth = parsePayload(payload);
  if (!auth) throw new Error(`Auth de codex incompleta en ${path}.`);

  let tokens = { ...auth.tokens };
  const claims = decodeJwt(tokens.access_token);
  const expiringSoon =
    typeof claims?.exp === "number" && claims.exp * 1000 <= Date.now() + REFRESH_SKEW_MS;
  if (expiringSoon) {
    tokens = await refreshTokens(tokens);
    payload.tokens = { ...payload.tokens, ...tokens };
    writePayload(path, payload);
  }

  return {
    baseURL: (env.CODEX_BASE_URL || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, ""),
    accessToken: tokens.access_token,
    accountId: auth.accountId,
  };
}

export function createCodexFetch(env = process.env) {
  return async (input, init = {}) => {
    const creds = await resolveCredentials(env);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${creds.accessToken}`);
    if (creds.accountId) headers.set("ChatGPT-Account-Id", creds.accountId);
    return fetch(input, { ...init, headers });
  };
}
