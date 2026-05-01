#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, rm, stat, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const ASSET_DIR = path.join(OUT_DIR, "release-assets");
const PROFILE_NAME = process.env.OPENCLAW_BUNDLE_PROFILE ?? "sandbox";

const REQUIRED_ASSETS = [
  ["openclaw.bundle.mjs", "entry"],
  ["bundle-deps.tar.gz", "runtime-deps"],
  ["bundle-openclaw-pkg.tar.gz", "openclaw-package-shim"],
  ["channels.tar.gz", "bundled-channel-extensions"],
  ["release.json", "release-metadata"],
  ["bundle-contract.json", "bundle-contract"],
];
const OPTIONAL_ASSETS = new Map([
  ["channel-shared-chunks.tar.gz", "bundled-channel-shared-dist-chunks"],
]);

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(command + " " + args.join(" ") + " exited with " + (code ?? signal)));
      }
    });
  });
}

function gitRevParse(ref) {
  const result = spawnSync("git", ["rev-parse", ref], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function assetRecord(fileName, role) {
  const filePath = path.join(ASSET_DIR, fileName);
  const info = await stat(filePath);
  return { role, bytes: info.size, sha256: await sha256File(filePath) };
}

async function copyRequiredAsset(fileName) {
  const source = path.join(OUT_DIR, fileName);
  const info = await stat(source).catch((err) => {
    if (err?.code === "ENOENT") {
      throw new Error("missing required sandbox bundle asset: " + path.relative(REPO_ROOT, source));
    }
    throw err;
  });
  if (!info.isFile() || info.size <= 0) {
    throw new Error("invalid sandbox bundle asset: " + path.relative(REPO_ROOT, source));
  }
  await copyFile(source, path.join(ASSET_DIR, fileName));
}

async function copyOptionalAsset(fileName) {
  const source = path.join(OUT_DIR, fileName);
  const info = await stat(source).catch(() => null);
  if (!info) {
    return false;
  }
  if (!info.isFile() || info.size <= 0) {
    throw new Error("invalid optional sandbox bundle asset: " + path.relative(REPO_ROOT, source));
  }
  await copyFile(source, path.join(ASSET_DIR, fileName));
  return true;
}

async function createTarball(fileName, entries) {
  await run("tar", ["-czf", fileName, ...entries], {
    cwd: ASSET_DIR,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
}

async function main() {
  const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));
  const packageVersion = pkg.version;
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("package.json is missing version");
  }
  const sha = gitRevParse("HEAD");
  if (!sha) {
    throw new Error("unable to resolve git HEAD sha");
  }
  const sha7 = sha.slice(0, 7);
  const tag = process.env.INPUT_TAG || process.env.GITHUB_REF_NAME || "v" + packageVersion;
  const canonicalTarName = "openclaw-sandbox-bundle-v" + packageVersion + "-" + sha7 + ".tar.gz";

  await rm(ASSET_DIR, { recursive: true, force: true });
  await mkdir(ASSET_DIR, { recursive: true });

  for (const [fileName] of REQUIRED_ASSETS) {
    await copyRequiredAsset(fileName);
  }
  const optionalAssets = [];
  for (const [fileName] of OPTIONAL_ASSETS) {
    if (await copyOptionalAsset(fileName)) {
      optionalAssets.push(fileName);
    }
  }

  const assetNames = [...REQUIRED_ASSETS.map(([fileName]) => fileName), ...optionalAssets];
  const assets = {};
  for (const [fileName, role] of REQUIRED_ASSETS) {
    assets[fileName] = await assetRecord(fileName, role);
  }
  for (const fileName of optionalAssets) {
    assets[fileName] = await assetRecord(fileName, OPTIONAL_ASSETS.get(fileName));
  }

  const manifest = {
    schemaVersion: 1,
    name: "openclaw-sandbox-bundle",
    profile: PROFILE_NAME,
    packageName: pkg.name ?? "openclaw",
    packageVersion,
    tag,
    git: { sha, sha7, upstreamSha: gitRevParse("upstream/main") },
    runtime: { nodeTarget: "node22", engines: pkg.engines?.node ?? ">=22.14.0" },
    canonicalTarball: canonicalTarName,
    assets,
  };
  await writeFile(
    path.join(ASSET_DIR, "asset-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  const tarEntries = [...assetNames, "asset-manifest.json"];
  await createTarball(canonicalTarName, tarEntries);

  const uploadedAssets = [canonicalTarName, ...tarEntries].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const checksumLines = [];
  for (const fileName of uploadedAssets) {
    checksumLines.push((await sha256File(path.join(ASSET_DIR, fileName))) + "  " + fileName);
  }
  await writeFile(path.join(ASSET_DIR, "checksums.sha256"), checksumLines.join("\n") + "\n");

  const entries = (await readdir(ASSET_DIR)).toSorted((left, right) => left.localeCompare(right));
  console.log(
    JSON.stringify({
      ok: true,
      assetDir: path.relative(REPO_ROOT, ASSET_DIR),
      canonicalTarball: canonicalTarName,
      uploadedAssetCount: entries.length,
      uploadedAssets: entries,
    }),
  );
}

main().catch((err) => {
  process.stderr.write("assemble-sandbox-release-assets: " + (err?.stack || err) + "\n");
  process.exit(1);
});
