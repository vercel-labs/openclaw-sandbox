import { createRequire } from "node:module";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";

// `@sinclair/typebox` is CJS. Pairing a static ESM `import` with the bundle's
// CJS-resolved alias map (and bolt's transitive requires) trips Node 22's
// "imported again after being required. Status = 0" dual-load when slack
// first does `await import(...)`. Lazy CJS require keeps a single transport.
const { Type } = createRequire(import.meta.url)(
  "@sinclair/typebox",
) as typeof import("@sinclair/typebox");
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { listSlackMessageActions } from "./message-actions.js";
import { createSlackMessageToolBlocksSchema } from "./message-tool-schema.js";

export function describeSlackMessageTool({
  cfg,
  accountId,
}: Parameters<NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>>[0]) {
  const actions = listSlackMessageActions(cfg, accountId);
  const capabilities = new Set<"blocks" | "interactive">();
  if (actions.includes("send")) {
    capabilities.add("blocks");
  }
  if (isSlackInteractiveRepliesEnabled({ cfg, accountId })) {
    capabilities.add("interactive");
  }
  return {
    actions,
    capabilities: Array.from(capabilities),
    schema: actions.includes("send")
      ? {
          properties: {
            blocks: Type.Optional(createSlackMessageToolBlocksSchema()),
          },
        }
      : null,
  };
}
