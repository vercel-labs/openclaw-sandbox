#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DEFAULT_ASSET_DIR = path.join(REPO_ROOT, "dist", "sandbox", "release-assets");
const REQUIRED_ASSETS = [
  "openclaw.bundle.mjs",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channels.tar.gz",
  "channel-catalog.json",
  "workspace-templates.tar.gz",
  "control-ui.tar.gz",
  "release.json",
  "bundle-contract.json",
  "asset-manifest.json",
  "checksums.sha256",
];
const REQUIRED_TAR_ENTRIES = [
  "asset-manifest.json",
  "bundle-contract.json",
  "bundle-deps.tar.gz",
  "bundle-openclaw-pkg.tar.gz",
  "channels.tar.gz",
  "channel-catalog.json",
  "control-ui.tar.gz",
  "openclaw.bundle.mjs",
  "release.json",
  "workspace-templates.tar.gz",
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
      console.log("usage: verify-sandbox-release-assets [--asset-dir <dir>]");
      process.exit(0);
    }
    throw new Error("unknown argument: " + arg);
  }
  return { assetDir: path.resolve(args.assetDir ?? DEFAULT_ASSET_DIR) };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function requireFile(assetDir, fileName) {
  const filePath = path.join(assetDir, fileName);
  const info = await stat(filePath).catch((err) => {
    if (err?.code === "ENOENT") {
      throw new Error("missing release asset: " + path.relative(REPO_ROOT, filePath));
    }
    throw err;
  });
  if (!info.isFile() || info.size <= 0) {
    throw new Error("invalid release asset: " + path.relative(REPO_ROOT, filePath));
  }
  return info;
}

function listTarEntries(assetDir, fileName) {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-tzf", fileName], {
      cwd: assetDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve(stdout.trim().split(/\r?\n/u).filter(Boolean));
      } else {
        reject(
          new Error("tar -tzf " + fileName + " exited with " + (code ?? signal) + ": " + stderr),
        );
      }
    });
  });
}

function parseChecksums(raw) {
  const entries = new Map();
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (!line.trim()) {
      continue;
    }
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match) {
      throw new Error("invalid checksums.sha256 line " + (index + 1) + ": " + line);
    }
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function main() {
  const { assetDir } = parseArgs(process.argv.slice(2));
  for (const fileName of REQUIRED_ASSETS) {
    await requireFile(assetDir, fileName);
  }

  const manifest = await readJson(path.join(assetDir, "asset-manifest.json"));
  if (manifest.schemaVersion !== 1) {
    throw new Error("asset-manifest.json schemaVersion must be 1");
  }
  if (manifest.name !== "openclaw-sandbox-bundle" || manifest.profile !== "sandbox") {
    throw new Error("asset-manifest.json does not describe the sandbox bundle");
  }
  if (
    typeof manifest.canonicalTarball !== "string" ||
    !manifest.canonicalTarball.endsWith(".tar.gz")
  ) {
    throw new Error("asset-manifest.json lacks canonicalTarball");
  }
  await requireFile(assetDir, manifest.canonicalTarball);

  const manifestAssets = manifest.assets;
  if (!manifestAssets || typeof manifestAssets !== "object" || Array.isArray(manifestAssets)) {
    throw new Error("asset-manifest.json lacks assets object");
  }
  for (const fileName of REQUIRED_ASSETS.filter(
    (entry) => entry !== "checksums.sha256" && entry !== "asset-manifest.json",
  )) {
    if (!manifestAssets[fileName]) {
      throw new Error("asset-manifest.json lacks assets." + fileName);
    }
  }

  const optionalChunk = path.join(assetDir, "channel-shared-chunks.tar.gz");
  const hasOptionalChunk = Boolean(await stat(optionalChunk).catch(() => null));
  if (hasOptionalChunk && !manifestAssets["channel-shared-chunks.tar.gz"]) {
    throw new Error("channel-shared-chunks.tar.gz exists but is absent from asset-manifest.json");
  }
  if (manifestAssets["channel-shared-chunks.tar.gz"] && !hasOptionalChunk) {
    throw new Error("asset-manifest.json lists channel-shared-chunks.tar.gz but file is missing");
  }

  for (const [fileName, record] of Object.entries(manifestAssets)) {
    const info = await requireFile(assetDir, fileName);
    if (record.bytes !== info.size) {
      throw new Error(
        "asset-manifest.json byte mismatch for " +
          fileName +
          ": " +
          record.bytes +
          " !== " +
          info.size,
      );
    }
    const actualSha = await sha256File(path.join(assetDir, fileName));
    if (record.sha256 !== actualSha) {
      throw new Error("asset-manifest.json sha256 mismatch for " + fileName);
    }
  }

  const expectedTarEntries = [
    ...REQUIRED_TAR_ENTRIES,
    ...(hasOptionalChunk ? ["channel-shared-chunks.tar.gz"] : []),
  ].toSorted((left, right) => left.localeCompare(right));
  const actualTarEntries = (await listTarEntries(assetDir, manifest.canonicalTarball)).toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (JSON.stringify(actualTarEntries) !== JSON.stringify(expectedTarEntries)) {
    throw new Error(
      "canonical tarball entries mismatch: expected " +
        expectedTarEntries.join(", ") +
        "; got " +
        actualTarEntries.join(", "),
    );
  }

  const checksums = parseChecksums(await readFile(path.join(assetDir, "checksums.sha256"), "utf8"));
  const expectedChecksumFiles = [manifest.canonicalTarball, ...expectedTarEntries].toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (
    JSON.stringify([...checksums.keys()].toSorted((left, right) => left.localeCompare(right))) !==
    JSON.stringify(expectedChecksumFiles)
  ) {
    throw new Error("checksums.sha256 file list does not match release asset set");
  }
  for (const [fileName, expectedSha] of checksums) {
    const actualSha = await sha256File(path.join(assetDir, fileName));
    if (actualSha !== expectedSha) {
      throw new Error("checksums.sha256 mismatch for " + fileName);
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      assetDir: path.relative(REPO_ROOT, assetDir),
      canonicalTarball: manifest.canonicalTarball,
      assetCount: expectedChecksumFiles.length + 1,
      optionalSharedChunks: hasOptionalChunk,
    }),
  );
}

main().catch((err) => {
  process.stderr.write("verify-sandbox-release-assets: " + (err?.stack || err) + "\n");
  process.exit(1);
});
