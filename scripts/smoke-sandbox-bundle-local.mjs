#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_ASSET_DIR = path.join(REPO_ROOT, "dist", "sandbox", "release-assets");
const FALLBACK_ASSET_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const WALL_CLOCK_MS = 60_000;
const FORBIDDEN_OUTPUT = [
  "Unable to resolve bundled plugin public surface",
  "Cannot find module",
  "ERR_MODULE_NOT_FOUND",
  "npm install",
  "pnpm install",
  "yarn install",
  "corepack",
  "imported again after being required",
  "Status = 0",
];

function parseArgs(argv) {
  const args = { assetDir: process.env.OPENCLAW_SANDBOX_BUNDLE_ASSET_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--asset-dir") {
      args.assetDir = argv[++i];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log("usage: smoke-sandbox-bundle-local [--asset-dir <dir>]");
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function exists(filePath) {
  return Boolean(await stat(filePath).catch(() => null));
}

async function resolveAssetDir(explicitAssetDir) {
  if (explicitAssetDir) {
    return path.resolve(explicitAssetDir);
  }
  if (await exists(DEFAULT_ASSET_DIR)) {
    return DEFAULT_ASSET_DIR;
  }
  return FALLBACK_ASSET_DIR;
}

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

async function extractTarball(fileName, cwd, targetDir = cwd) {
  await mkdir(targetDir, { recursive: true });
  await run("tar", ["-xzf", path.resolve(cwd, fileName)], {
    cwd: targetDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

async function findReleaseTar(assetDir) {
  const entries = await readdir(assetDir).catch(() => []);
  const versioned = entries.find((entry) =>
    /^openclaw-sandbox-bundle-v.+-[0-9a-f]{7}\.tar\.gz$/u.test(entry),
  );
  return (
    versioned ?? (entries.includes("openclaw-release.tar.gz") ? "openclaw-release.tar.gz" : null)
  );
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

function runBundle(cwd, homeDir, extensionsDir) {
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
        OPENCLAW_BUNDLED_PLUGINS_DIR: extensionsDir,
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

async function copyAsset(assetDir, tmpRoot, fileName) {
  const source = path.join(assetDir, fileName);
  if (!(await exists(source))) {
    throw new Error(`missing required release asset: ${path.relative(REPO_ROOT, source)}`);
  }
  await copyFile(source, path.join(tmpRoot, fileName));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const assetDir = await resolveAssetDir(args.assetDir);
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-sandbox-bundle-smoke-"));
  try {
    const homeDir = path.join(tmpRoot, "home");
    const extensionsDir = path.join(tmpRoot, "extensions");
    await mkdir(homeDir, { recursive: true });

    const releaseTar = await findReleaseTar(assetDir);
    if (releaseTar) {
      await copyAsset(assetDir, tmpRoot, releaseTar);
      await extractTarball(releaseTar, tmpRoot);
    } else {
      await copyAsset(assetDir, tmpRoot, "openclaw.bundle.mjs");
    }

    for (const sidecar of ["bundle-deps.tar.gz", "bundle-openclaw-pkg.tar.gz", "channels.tar.gz"]) {
      if (!(await exists(path.join(tmpRoot, sidecar)))) {
        await copyAsset(assetDir, tmpRoot, sidecar);
      }
    }
    await extractTarball("bundle-deps.tar.gz", tmpRoot);
    await extractTarball("bundle-openclaw-pkg.tar.gz", tmpRoot);
    await extractTarball("channels.tar.gz", tmpRoot, extensionsDir);

    if (
      !(await exists(path.join(tmpRoot, "channel-shared-chunks.tar.gz"))) &&
      (await exists(path.join(assetDir, "channel-shared-chunks.tar.gz")))
    ) {
      await copyAsset(assetDir, tmpRoot, "channel-shared-chunks.tar.gz");
    }
    if (await exists(path.join(tmpRoot, "channel-shared-chunks.tar.gz"))) {
      await extractTarball("channel-shared-chunks.tar.gz", tmpRoot);
    }

    const result = await runBundle(tmpRoot, homeDir, extensionsDir);
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
        assetDir: path.relative(REPO_ROOT, assetDir),
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
