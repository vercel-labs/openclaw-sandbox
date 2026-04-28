import { createRequire } from "node:module";

// See message-tool-api.ts for the CJS-require rationale (Node 22 dual-load).
const { Type } = createRequire(import.meta.url)(
  "@sinclair/typebox",
) as typeof import("@sinclair/typebox");

export function createSlackMessageToolBlocksSchema() {
  return Type.Array(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description: "Slack Block Kit payload blocks (Slack only).",
      },
    ),
  );
}
