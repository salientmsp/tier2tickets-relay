#!/usr/bin/env node
// Enforce the ingress/egress boundary (the one rule the layout exists to serve):
//
//   src/ingress/ and src/egress/ must NEVER import each other.
//   Both may import src/core/. src/index.ts may import all three.
//
// This keeps ticket sources (ingress) and fan-out sinks (egress) decoupled — they
// meet only through src/core/events.ts. A crossing import is a build failure.
//
// Zero dependencies (Node's stdlib only) so it adds nothing to the toolchain; wired
// into CI (.github/workflows/ci.yml) and runnable locally via `npm run lint:boundaries`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "src");
const ingressDir = join(srcRoot, "ingress");
const egressDir = join(srcRoot, "egress");

/** The forbidden pairs: a file under `dir` must not import anything under `forbidden`. */
const RULES = [
  { dir: ingressDir, forbidden: egressDir, label: "ingress → egress" },
  { dir: egressDir, forbidden: ingressDir, label: "egress → ingress" },
];

/** Every .ts file under a directory (recursively). Missing dir => no files. */
function tsFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Match static import/export-from specifiers and dynamic import("…"). Captures the
// specifier in group 2 (import/export … from "x") or group 3 (import("x")).
const SPECIFIER_RE =
  /(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Resolve a relative specifier to an absolute path (drops any .js/.ts extension). */
function resolveSpecifier(fromFile, spec) {
  const abs = resolve(dirname(fromFile), spec);
  return abs.replace(/\.(js|ts)$/, "");
}

/** True if `abs` is inside `dir` (or is `dir` itself). */
function isInside(abs, dir) {
  const rel = relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !resolve(dir, rel).startsWith(".."));
}

const violations = [];
for (const { dir, forbidden, label } of RULES) {
  for (const file of tsFiles(dir)) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(SPECIFIER_RE)) {
      const spec = m[1] ?? m[2];
      if (!spec || !spec.startsWith(".")) continue; // only relative imports can cross
      const target = resolveSpecifier(file, spec);
      if (isInside(target, forbidden)) {
        violations.push({ label, file: relative(repoRoot, file), spec });
      }
    }
  }
}

if (violations.length) {
  console.error("✗ ingress/egress import-boundary violations:\n");
  for (const v of violations) {
    console.error(`  [${v.label}]  ${v.file}  imports  "${v.spec}"`);
  }
  console.error(
    "\ningress/ and egress/ must not import each other — route through src/core/ (e.g. core/events.ts).",
  );
  process.exit(1);
}

console.log("✓ ingress/egress import boundary clean");
