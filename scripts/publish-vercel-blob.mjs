#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const OUT_DIR = path.join(REPO_ROOT, "dist", "sandbox");
const RELEASE_JSON_PATH = path.join(OUT_DIR, "release.json");
const CONTRACT_JSON_PATH = path.join(OUT_DIR, "bundle-contract.json");
const RELEASE_TAR_PATH = path.join(OUT_DIR, "openclaw-release.tar.gz");
const WALL_CLOCK_MS = 5 * 60 * 1000;

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function requireBlobToken() {
  const tokenStatus = process.env.BLOB_READ_WRITE_TOKEN ? "present" : "missing";
  if (tokenStatus === "missing") {
    throw new Error(
      "missing BLOB_READ_WRITE_TOKEN env var; token status: missing. Set it before publishing.",
    );
  }
  return process.env.BLOB_READ_WRITE_TOKEN;
}

async function upload(pathname, body, options) {
  return put(pathname, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    token: options.token,
    cacheControlMaxAge: options.cacheControlMaxAge,
    contentType: options.contentType,
  });
}

async function main() {
  const timeout = setTimeout(() => {
    process.stderr.write(`publish-vercel-blob: exceeded ${WALL_CLOCK_MS}ms wall clock\n`);
    process.exit(1);
  }, WALL_CLOCK_MS);
  timeout.unref();

  const token = requireBlobToken();
  const release = await readJson(RELEASE_JSON_PATH);
  const bundleSha256 = release.bundleSha256;
  if (typeof bundleSha256 !== "string" || bundleSha256.length < 7) {
    throw new Error("release.json lacks a usable bundleSha256");
  }

  const bundleSha7 = bundleSha256.slice(0, 7);
  const tarData = await readFile(RELEASE_TAR_PATH);
  const tarInfo = await stat(RELEASE_TAR_PATH);
  if (tarInfo.size <= 0) {
    throw new Error("openclaw-release.tar.gz is empty");
  }
  const releaseJsonData = await readFile(RELEASE_JSON_PATH);
  const contractJsonData = await readFile(CONTRACT_JSON_PATH);
  const tarSha256 = sha256(tarData);

  const immutable = await upload(`openclaw-release-${bundleSha7}.tar.gz`, tarData, {
    token,
    cacheControlMaxAge: 2_592_000,
    contentType: "application/gzip",
  });
  const latest = await upload("openclaw-release.tar.gz", tarData, {
    token,
    cacheControlMaxAge: 60,
    contentType: "application/gzip",
  });
  const releaseJson = await upload("release.json", releaseJsonData, {
    token,
    cacheControlMaxAge: 60,
    contentType: "application/json",
  });
  const bundleContract = await upload("bundle-contract.json", contractJsonData, {
    token,
    cacheControlMaxAge: 60,
    contentType: "application/json",
  });

  // vclaw passes --bundle-url <openclaw.bundle.mjs URL>; vercel-openclaw's
  // bootstrap then resolves sibling URLs (channels.tar.gz, bundle-deps.tar.gz,
  // bundle-openclaw-pkg.tar.gz, channel-shared-chunks.tar.gz) by relative path
  // against that .mjs URL. Publish each as a sibling so a single Blob path
  // serves the whole sandbox bootstrap.
  const SIBLING_FILES = [
    { pathname: "openclaw.bundle.mjs", contentType: "application/javascript" },
    { pathname: "bundle-deps.tar.gz", contentType: "application/gzip" },
    { pathname: "bundle-openclaw-pkg.tar.gz", contentType: "application/gzip" },
    { pathname: "channels.tar.gz", contentType: "application/gzip" },
    { pathname: "channel-shared-chunks.tar.gz", contentType: "application/gzip" },
  ];
  const siblingUrls = {};
  for (const file of SIBLING_FILES) {
    const filePath = path.join(OUT_DIR, file.pathname);
    const data = await readFile(filePath);
    const result = await upload(file.pathname, data, {
      token,
      cacheControlMaxAge: 60,
      contentType: file.contentType,
    });
    siblingUrls[file.pathname] = result.url;
  }

  clearTimeout(timeout);
  console.log(
    JSON.stringify({
      ok: true,
      bundleUrl: siblingUrls["openclaw.bundle.mjs"],
      siblingUrls,
      immutableUrl: immutable.url,
      latestUrl: latest.url,
      releaseJsonUrl: releaseJson.url,
      bundleContractUrl: bundleContract.url,
      tarSha256,
      tarBytes: tarInfo.size,
      bundleSha256,
      bundleSha7,
    }),
  );
}

main().catch((err) => {
  process.stderr.write(`publish-vercel-blob: ${err?.message || err}\n`);
  process.exit(1);
});
