#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const WALL_CLOCK_MS = 60_000;
const RELEASE_TAR_FILE = "openclaw-release.tar.gz";
const FORBIDDEN_OUTPUT = [
  "Unable to resolve bundled plugin public surface",
  "Cannot find module",
  "ERR_MODULE_NOT_FOUND",
  "npm install",
  "pnpm install",
  "yarn install",
  "corepack",
  // Node 22 ESM/CJS dual-load — what slack hits when jiti is imported both
  // ways. The build-side static-import guard in verify-sandbox-bundle-contract
  // should already prevent this; keep the runtime check as defense in depth.
  "imported again after being required",
  "Status = 0",
];

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? signal}`));
      }
    });
  });
}

async function extractTarball(fileName, cwd) {
  await run("tar", ["-xzf", fileName], { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

function parseSmokeLine(output) {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith("[bundle-smoke] ")) {
      continue;
    }
    const payload = line.slice("[bundle-smoke] ".length);
    try {
      const parsed = JSON.parse(payload);
      if (parsed?.ok === true) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function runBundle(cwd, homeDir) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    let output = "";
    let settled = false;
    const child = spawn(process.execPath, ["openclaw.bundle.mjs"], {
      cwd,
      env: {
        HOME: homeDir,
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        OPENCLAW_BUNDLE_PROFILE: "sandbox",
        OPENCLAW_BUNDLE_SMOKE: "1",
        OPENCLAW_PLUGIN_LOAD_PROFILE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`bundle smoke exceeded ${WALL_CLOCK_MS}ms wall clock`));
    }, WALL_CLOCK_MS);
    const collect = (chunk) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        code,
        signal,
        output,
        elapsedMs: Math.round(performance.now() - start),
      });
    });
  });
}

async function main() {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-bundle-smoke-"));
  try {
    const homeDir = path.join(tmpRoot, "home");
    await mkdir(homeDir, { recursive: true });
    await copyFile(path.join(OUT_DIR, RELEASE_TAR_FILE), path.join(tmpRoot, RELEASE_TAR_FILE));

    await extractTarball(RELEASE_TAR_FILE, tmpRoot);
    await extractTarball("bundle-deps.tar.gz", tmpRoot);
    await extractTarball("bundle-openclaw-pkg.tar.gz", tmpRoot);

    const result = await runBundle(tmpRoot, homeDir);
    const forbiddenHit = FORBIDDEN_OUTPUT.find((needle) => result.output.includes(needle));
    if (forbiddenHit) {
      throw new Error(
        `bundle smoke output contained forbidden text: ${forbiddenHit}\n${result.output}`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `bundle smoke exited nonzero: ${result.code ?? result.signal}\n${result.output}`,
      );
    }
    const smoke = parseSmokeLine(result.output);
    if (!smoke) {
      throw new Error(`bundle smoke did not print [bundle-smoke] ok:true JSON\n${result.output}`);
    }
    const pluginLoadProfileCount = result.output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("[plugin-load-profile]")).length;
    console.log(
      JSON.stringify({
        ok: true,
        elapsedMs: result.elapsedMs,
        bundleSmoke: smoke,
        pluginLoadProfileCount,
      }),
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  process.stderr.write(`smoke-sandbox-bundle-local: ${err?.stack || err}\n`);
  process.exit(1);
});
