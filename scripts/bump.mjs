#!/usr/bin/env node
// Bump the app version in all three places that must stay in sync, then
// commit and tag. Does NOT push — pushing the tag is what triggers the
// release pipeline, so that stays a deliberate manual step.
//
//   bun run bump 0.2.0      # explicit version
//   bun run bump patch      # 0.1.0 -> 0.1.1
//   bun run bump minor      # 0.1.0 -> 0.2.0
//   bun run bump major      # 0.1.0 -> 1.0.0
//
// Flags: --no-commit (only edit files), --no-tag (commit but don't tag)

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith("-"));
const noCommit = args.includes("--no-commit");
const noTag = args.includes("--no-tag");

function die(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

if (!bump) {
  die("Usage: bun run bump <version|major|minor|patch> [--no-commit] [--no-tag]");
}

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const gitIO = (...a) => execFileSync("git", a, { cwd: root, stdio: "inherit" });

const pkgPath = join(root, "package.json");
const confPath = join(root, "src-tauri", "tauri.conf.json");
const cargoPath = join(root, "src-tauri", "Cargo.toml");
const lockPath = join(root, "src-tauri", "Cargo.lock");

const current = JSON.parse(readFileSync(pkgPath, "utf8")).version;
if (!current) die("Could not read current version from package.json");

function resolveVersion(cur, spec) {
  if (/^\d+\.\d+\.\d+$/.test(spec)) return spec;
  const m = cur.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) die(`Current version "${cur}" isn't x.y.z — pass an explicit version.`);
  const [maj, min, pat] = m.slice(1).map(Number);
  if (spec === "major") return `${maj + 1}.0.0`;
  if (spec === "minor") return `${maj}.${min + 1}.0`;
  if (spec === "patch") return `${maj}.${min}.${pat + 1}`;
  die(`Unknown bump "${spec}" — use major | minor | patch | x.y.z`);
}

const version = resolveVersion(current, bump);
const tag = `v${version}`;

// --- safety checks before touching anything ---
if (!noTag) {
  let exists = false;
  try { git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`); exists = true; } catch {}
  if (exists) die(`Tag ${tag} already exists.`);
}
if (!noCommit) {
  // Refuse if something is already staged — we only want the version files in this commit.
  try { execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root }); }
  catch { die("You have staged changes. Commit or unstage them before bumping."); }
}

// --- edit the three files (targeted replacements keep formatting intact) ---
function replaceOnce(path, re, replacement, label) {
  const txt = readFileSync(path, "utf8");
  if (!re.test(txt)) die(`Could not find the version field in ${label}.`);
  writeFileSync(path, txt.replace(re, replacement));
}

replaceOnce(pkgPath, /("version"\s*:\s*)"[^"]*"/, `$1"${version}"`, "package.json");
replaceOnce(confPath, /("version"\s*:\s*)"[^"]*"/, `$1"${version}"`, "tauri.conf.json");
replaceOnce(cargoPath, /^version\s*=\s*"[^"]*"/m, `version = "${version}"`, "Cargo.toml");
// Sync the app package's version in Cargo.lock too (the entry whose `name =
// "app"`), so the lockfile doesn't lag a version behind in the release commit.
// A targeted text edit — no cargo run, no network, no dependency re-resolution.
replaceOnce(lockPath, /(name = "app"\r?\nversion = )"[^"]*"/, `$1"${version}"`, "Cargo.lock");

console.log(`✓ ${current} → ${version} (package.json, tauri.conf.json, Cargo.toml, Cargo.lock)`);

// --- commit + tag ---
if (noCommit) {
  console.log("• Files updated. Skipped commit (--no-commit).");
  process.exit(0);
}

gitIO("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock");
gitIO("commit", "-m", `chore: release ${tag}`);
console.log(`✓ committed "chore: release ${tag}"`);

if (noTag) {
  console.log("• Skipped tag (--no-tag).");
} else {
  gitIO("tag", tag);
  console.log(`✓ created tag ${tag}`);
}

console.log("\nNext — push to trigger the release pipeline:");
console.log(`  git push && git push origin ${tag}`);
