#!/usr/bin/env node
/**
 * One-shot ESM bundle builder for openclaw.
 * Produces dist-vercel-runtime/moonshot/openclaw.bundle.mjs
 *
 * Key difference from the CJS builder: uses format: 'esm' to support
 * top-level await in dist/entry.js, and injects a createRequire shim
 * so CJS deps (like `debug`) that call require("tty") still work.
 */

import { mkdir, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DIST_ENTRY = path.join(REPO_ROOT, "dist", "entry.js");
const STUB = path.join(REPO_ROOT, "build", "stubs", "disabled-optional.cjs");
const OUT_DIR = path.join(REPO_ROOT, "dist-vercel-runtime", "moonshot");
const OUT_FILE = path.join(OUT_DIR, "openclaw.bundle.mjs");

const log = (...parts) => process.stderr.write(parts.join(" ") + "\n");

const createRequireRewritePlugin = {
  name: "openclaw-createrequire-inline",
  setup(build) {
    build.onLoad({ filter: /\.(m?js|cjs|ts|mts|cts)$/ }, async (args) => {
      if (args.path.includes(`${path.sep}node_modules${path.sep}`)) {
        return null;
      }
      const source = await readFile(args.path, "utf8");
      if (!source.includes("createRequire(import.meta.url)")) {
        return null;
      }
      let rewritten = source.replace(
        /createRequire\(import\.meta\.url\)\(("[^"]+"|'[^']+')\)/g,
        "require($1)",
      );

      // Collect literal `./*.runtime.{js,ts}` candidates referenced in this
      // file. These are the modules that callers will pass as variables to a
      // dynamic require, and esbuild can't see those dynamic calls.
      // Only collect .js candidates — esbuild is bundling already-compiled
      // dist/*.js output, so .ts candidates are unresolvable runtime fallbacks
      // (used only by jiti dev paths). Including them produces resolve errors.
      const runtimeCandidatePattern = /["']\.\/[\w./-]+\.runtime\.js["']/g;
      const candidates = new Set();
      for (const match of rewritten.matchAll(runtimeCandidatePattern)) {
        candidates.add(match[0].slice(1, -1));
      }

      // Rewrite `const X = createRequire(import.meta.url)`:
      // - If X === "require": delete (banner already provides require).
      // - If we have known runtime candidates: replace with a switch wrapper
      //   that calls static `require("./literal")` for each known candidate so
      //   esbuild bundles them and the dynamic `X(candidate)` call resolves
      //   through the bundle's module map at runtime.
      // - Otherwise: alias X to the banner's require.
      rewritten = rewritten.replace(
        /((?:const|let|var)\s+)([\w$]+)(\s*=\s*)createRequire\(import\.meta\.url\)(?!\()(;\n?)/g,
        (_match, decl, name, eq, end) => {
          if (name === "require") {
            return "";
          }
          if (candidates.size > 0) {
            const cases = Array.from(candidates)
              .map((c) => `case ${JSON.stringify(c)}:return require(${JSON.stringify(c)});`)
              .join("");
            return `${decl}${name}${eq}((__c)=>{switch(__c){${cases}default:return require(__c);}})${end}`;
          }
          return `${decl}${name}${eq}require${end}`;
        },
      );

      // Belt-and-suspenders: also append top-level static requires so esbuild
      // bundles the runtime modules even if the createRequire pattern wasn't
      // matched (e.g. a callsite that constructs require some other way).
      if (candidates.size > 0) {
        const stub = Array.from(candidates)
          .map((c) => `try{require(${JSON.stringify(c)});}catch{}`)
          .join("");
        rewritten += `\n;(()=>{${stub}})();\n`;
      }
      return rewritten === source ? null : { contents: rewritten, loader: "js" };
    });
  },
};

const main = async () => {
  await mkdir(OUT_DIR, { recursive: true });

  if (!(await stat(DIST_ENTRY).catch(() => null))) {
    throw new Error(`missing dist/entry.js — run pnpm build first`);
  }

  const { build } = await import("esbuild");
  log("bundling ESM via esbuild...");

  // Banner: inject createRequire so CJS modules that call require("tty")
  // etc. still work inside the ESM bundle.
  const banner = [
    'import { createRequire as __openclaw_createRequire } from "node:module";',
    "const require = __openclaw_createRequire(import.meta.url);",
  ].join("\n");

  const result = await build({
    entryPoints: [DIST_ENTRY],
    outfile: OUT_FILE,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "bundle",
    mainFields: ["module", "main"],
    resolveExtensions: [".js", ".mjs", ".cjs", ".json"],
    minifySyntax: true,
    minifyWhitespace: true,
    keepNames: true,
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
    banner: { js: banner },
    alias: {
      sharp: STUB,
      keytar: STUB,
      "@reflink/reflink": STUB,
      "@napi-rs/canvas": STUB,
    },
    external: ["fsevents", "@img/sharp-*", "@node-llama-cpp/*", "node-llama-cpp"],
    plugins: [createRequireRewritePlugin],
  });

  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify(result.metafile, null, 2));

  const outStat = await stat(OUT_FILE);
  log(`\nbundle: ${path.relative(REPO_ROOT, OUT_FILE)}`);
  log(`  size: ${(outStat.size / (1024 * 1024)).toFixed(2)} MB`);
  log("done.");
};

main().catch((err) => {
  process.stderr.write(`build-bundle-esm: ${err?.stack || err}\n`);
  process.exit(1);
});
