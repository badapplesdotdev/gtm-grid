// Sync the app version across the files Tauri/Cargo can't read from package.json.
//
// `changeset version` bumps the @gtmgrid/desktop package.json (the version of
// record for the shipped app). This propagates that version into:
//   - packages/desktop/src-tauri/tauri.conf.json  ("version")
//   - packages/desktop/src-tauri/Cargo.toml        ([package] version)
//   - the root package.json                        ("version", cosmetic)
//
// Run by `pnpm version-packages` right after `changeset version`, so a single
// release cut keeps every version string in lockstep.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(repo, p), "utf8");
const write = (p, s) => writeFileSync(resolve(repo, p), s);

const DESKTOP_PKG = "packages/desktop/package.json";
const TAURI_CONF = "packages/desktop/src-tauri/tauri.conf.json";
const CARGO_TOML = "packages/desktop/src-tauri/Cargo.toml";
const ROOT_PKG = "package.json";

const version = JSON.parse(read(DESKTOP_PKG)).version;
if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`sync-app-version: refusing to sync invalid version "${version}"`);
  process.exit(1);
}

// tauri.conf.json — top-level "version" string.
const conf = JSON.parse(read(TAURI_CONF));
conf.version = version;
write(TAURI_CONF, JSON.stringify(conf, null, 2) + "\n");

// Cargo.toml — first `version = "..."` under [package]. Replace only that one.
let cargo = read(CARGO_TOML);
cargo = cargo.replace(/(\[package\][^[]*?\nversion\s*=\s*")[^"]*(")/, `$1${version}$2`);
write(CARGO_TOML, cargo);

// Root package.json — cosmetic, keep it aligned.
const root = JSON.parse(read(ROOT_PKG));
root.version = version;
write(ROOT_PKG, JSON.stringify(root, null, 2) + "\n");

console.log(`Synced app version ${version} → tauri.conf.json, Cargo.toml, package.json`);
