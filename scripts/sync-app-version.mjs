// Sync the app version of record into the root package.json.
//
// `changeset version` bumps the @gtmgrid/desktop package.json (the version of
// record for the shipped Electron app — electron-builder reads it directly). We
// just keep the root package.json aligned (cosmetic). Run by `pnpm version-packages`
// right after `changeset version`.
//
// (The old Tauri targets — tauri.conf.json + Cargo.toml — are gone with the
// Electron migration; electron-builder derives the app version from package.json.)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(repo, p), "utf8");
const write = (p, s) => writeFileSync(resolve(repo, p), s);

const DESKTOP_PKG = "packages/desktop/package.json";
const ROOT_PKG = "package.json";

const version = JSON.parse(read(DESKTOP_PKG)).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-app-version: refusing to sync invalid version "${version}"`);
  process.exit(1);
}

const root = JSON.parse(read(ROOT_PKG));
root.version = version;
write(ROOT_PKG, JSON.stringify(root, null, 2) + "\n");

console.log(`Synced app version ${version} → root package.json`);
