import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeSlackWebhookPath } from "./paths.js";

export { normalizeSlackWebhookPath } from "./paths.js";

export type SlackHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type RegisterSlackHttpHandlerArgs = {
  path?: string | null;
  handler: SlackHttpRequestHandler;
  log?: (message: string) => void;
  accountId?: string;
};

// Pin the registry to globalThis so dual-loaded module instances (e.g.
// jiti-evaluated CJS vs native ESM) still share state. Without this pin a
// route registered via the monitor module instance becomes invisible to the
// request-time handler module instance and every inbound webhook returns 404.
const SLACK_HTTP_ROUTES_GLOBAL_KEY = Symbol.for("openclaw.slack.httpRoutes");
type SlackHttpRoutesGlobal = typeof globalThis & {
  [SLACK_HTTP_ROUTES_GLOBAL_KEY]?: Map<string, SlackHttpRequestHandler>;
};
const slackGlobal = globalThis as SlackHttpRoutesGlobal;
const slackHttpRoutes: Map<string, SlackHttpRequestHandler> =
  slackGlobal[SLACK_HTTP_ROUTES_GLOBAL_KEY] ??
  (slackGlobal[SLACK_HTTP_ROUTES_GLOBAL_KEY] = new Map());

export function registerSlackHttpHandler(params: RegisterSlackHttpHandlerArgs): () => void {
  const normalizedPath = normalizeSlackWebhookPath(params.path);
  if (slackHttpRoutes.has(normalizedPath)) {
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    params.log?.(`slack: webhook path ${normalizedPath} already registered${suffix}`);
    return () => {};
  }
  slackHttpRoutes.set(normalizedPath, params.handler);
  return () => {
    slackHttpRoutes.delete(normalizedPath);
  };
}

export async function handleSlackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = slackHttpRoutes.get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
