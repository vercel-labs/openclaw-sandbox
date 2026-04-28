import { createRequire } from "node:module";
import type { RetryOptions, WebClientOptions, WebClient as WebClientType } from "@slack/web-api";
import { resolveEnvHttpProxyUrl } from "openclaw/plugin-sdk/infra-runtime";

// `https-proxy-agent` stays out of the static import graph for the same
// reason web-api and bolt do: any package that participates in a CJS-require
// chain elsewhere in the bundled slack runtime risks Node 22 dual-load.
type HttpsProxyAgentCtor = typeof import("https-proxy-agent").HttpsProxyAgent;
type SlackProxyAgent = InstanceType<HttpsProxyAgentCtor>;
let cachedHttpsProxyAgentCtor: HttpsProxyAgentCtor | undefined;
function getHttpsProxyAgentCtor(): HttpsProxyAgentCtor {
  if (cachedHttpsProxyAgentCtor) {
    return cachedHttpsProxyAgentCtor;
  }
  const mod = createRequire(import.meta.url)("https-proxy-agent") as {
    HttpsProxyAgent: HttpsProxyAgentCtor;
  };
  cachedHttpsProxyAgentCtor = mod.HttpsProxyAgent;
  return cachedHttpsProxyAgentCtor;
}

// `@slack/web-api` is CJS. `@slack/bolt` (also CJS) `require()`s the same
// package internally; pairing that with a static ESM `import` here trips
// Node 22's "imported again after being required. Status = 0" dual-load.
// Load WebClient via CJS so the bundle has a single transport for web-api.
let cachedWebClientCtor: typeof WebClientType | undefined;
function getWebClientCtor(): typeof WebClientType {
  if (cachedWebClientCtor) {
    return cachedWebClientCtor;
  }
  const mod = createRequire(import.meta.url)("@slack/web-api") as {
    WebClient: typeof WebClientType;
  };
  cachedWebClientCtor = mod.WebClient;
  return cachedWebClientCtor;
}

export const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3000,
  randomize: true,
};

export const SLACK_WRITE_RETRY_OPTIONS: RetryOptions = {
  retries: 0,
};

/**
 * Check whether a hostname is excluded from proxying by `NO_PROXY` / `no_proxy`.
 * Supports comma-separated entries with optional leading dots (e.g. `.slack.com`).
 */
function isHostExcludedByNoProxy(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.no_proxy ?? env.NO_PROXY;
  if (!raw) {
    return false;
  }
  const entries = raw
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const lower = hostname.toLowerCase();
  for (const entry of entries) {
    if (entry === "*") {
      return true;
    }
    // Strip optional wildcard/leading dot so `*.slack.com` and `.slack.com`
    // match both `slack.com` (apex) and Slack subdomains.
    const bare = entry.startsWith("*.")
      ? entry.slice(2)
      : entry.startsWith(".")
        ? entry.slice(1)
        : entry;
    if (lower === bare || lower.endsWith(`.${bare}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Build an HTTPS proxy agent from env vars (HTTPS_PROXY, HTTP_PROXY, etc.)
 * for use as the `agent` option in Slack WebClient and Socket Mode connections.
 *
 * When set, this agent is forwarded through @slack/bolt → @slack/socket-mode →
 * SlackWebSocket as the `httpAgent`, which the `ws` library uses to tunnel the
 * WebSocket upgrade request through the proxy.  This fixes Socket Mode in
 * environments where outbound traffic must go through an HTTP CONNECT proxy.
 *
 * Respects `NO_PROXY` / `no_proxy` — if `*.slack.com` (or a matching pattern)
 * appears in the exclusion list, returns `undefined` so the connection is direct.
 *
 * Returns `undefined` when no proxy env var is configured or when Slack hosts
 * are excluded by `NO_PROXY`.
 */
function resolveSlackProxyAgent(): SlackProxyAgent | undefined {
  const proxyUrl = resolveEnvHttpProxyUrl("https");
  if (!proxyUrl) {
    return undefined;
  }
  // Slack Socket Mode connects to these hosts; skip proxy if excluded.
  if (isHostExcludedByNoProxy("slack.com")) {
    return undefined;
  }
  try {
    return new (getHttpsProxyAgentCtor())(proxyUrl);
  } catch {
    // Malformed proxy URL — degrade gracefully to direct connection.
    return undefined;
  }
}

/**
 * E2E-only Slack API URL override. Honored ONLY when the override resolves to
 * a loopback host (127.0.0.1, ::1, or localhost) so production traffic can
 * never be silently redirected by a hostile env.
 */
function resolveSlackApiUrlOverride(): string | undefined {
  const raw = process.env.OPENCLAW_SLACK_API_URL_OVERRIDE?.trim();
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
      return raw;
    }
  } catch {
    // ignore malformed override
  }
  return undefined;
}

export function resolveSlackWebClientOptions(options: WebClientOptions = {}): WebClientOptions {
  const apiUrlOverride = resolveSlackApiUrlOverride();
  return {
    ...options,
    agent: options.agent ?? resolveSlackProxyAgent(),
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS,
    ...(apiUrlOverride && options.slackApiUrl === undefined ? { slackApiUrl: apiUrlOverride } : {}),
  };
}

export function resolveSlackWriteClientOptions(options: WebClientOptions = {}): WebClientOptions {
  const apiUrlOverride = resolveSlackApiUrlOverride();
  return {
    ...options,
    agent: options.agent ?? resolveSlackProxyAgent(),
    retryConfig: options.retryConfig ?? SLACK_WRITE_RETRY_OPTIONS,
    ...(apiUrlOverride && options.slackApiUrl === undefined ? { slackApiUrl: apiUrlOverride } : {}),
  };
}

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new (getWebClientCtor())(token, resolveSlackWebClientOptions(options));
}

export function createSlackWriteClient(token: string, options: WebClientOptions = {}) {
  return new (getWebClientCtor())(token, resolveSlackWriteClientOptions(options));
}
