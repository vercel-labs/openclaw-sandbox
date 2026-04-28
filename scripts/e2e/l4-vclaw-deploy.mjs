#!/usr/bin/env node

/**
 * L4 — vclaw deploy roundtrip e2e (opt-in, real Vercel).
 *
 * Publishes the current bundle, runs `vclaw create --non-interactive` against
 * a throwaway Vercel project, posts a signed Slack Events API payload to the
 * deployed `/api/channels/slack/webhook`, asserts 200, then deletes the
 * project.
 *
 * BLOCKED until two prerequisites land:
 *
 *   1. `vclaw` exposes a non-interactive mode that fails fast on any prompt
 *      and accepts every required value via flags. Today `vclaw create` is
 *      interactive end-to-end. (Separate vclaw PR.)
 *
 *   2. Required env: VERCEL_TOKEN, OPENCLAW_E2E_VERCEL_TEAM,
 *      OPENCLAW_E2E_VERCEL_PROJECT_PREFIX (refuses to run otherwise).
 *
 * When those land, replace this stub body with the deploy flow described in
 * /Users/johnlindquist/.claude/plans/squishy-conjuring-sonnet.md§L4.
 */

import process from "node:process";

const REQUIRED_ENV = [
  "VERCEL_TOKEN",
  "OPENCLAW_E2E_VERCEL_TEAM",
  "OPENCLAW_E2E_VERCEL_PROJECT_PREFIX",
];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());

process.stderr.write(
  [
    "l4-vclaw-deploy: not yet implemented.",
    "",
    `Required env (${missing.length === 0 ? "present" : "missing: " + missing.join(", ")}):`,
    ...REQUIRED_ENV.map((key) => `  - ${key}`),
    "",
    "Blocked on:",
    "  - vclaw --non-interactive (separate PR in ~/dev/vclaw)",
    "Plan: /Users/johnlindquist/.claude/plans/squishy-conjuring-sonnet.md (L4 section)",
    "",
  ].join("\n"),
);
process.exit(2);
