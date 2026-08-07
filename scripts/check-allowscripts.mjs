// Guard: keep package.json `allowScripts` covering the dependencies whose install
// scripts we allow under npm v12 (which blocks dependency install scripts by default).
// `allowScripts` is keyed by bare package NAME (not `name@version`), matching the
// convention every comparable tool uses (pnpm `onlyBuiltDependencies`, bun
// `trustedDependencies`): the allowlist is decided per package, not per version, so a
// Renovate version bump never invalidates it and no post-upgrade regeneration step is
// needed. This check verifies each required package is present in the LOCKFILE
// (deterministic; matches what `npm ci` installs) and allowlisted by name, failing with
// the exact remediation otherwise. Run in CI and locally (`npm run check:allowscripts`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

// Dependencies whose npm-v12 install scripts we intentionally allow.
// workerd = wrangler dev's runtime; esbuild = the bundler. Both fetch native binaries.
const PACKAGES = ["workerd", "esbuild"];

const lock = read("package-lock.json");
const allow = read("package.json").allowScripts ?? {};

const problems = [];
for (const name of PACKAGES) {
  const version = lock.packages?.[`node_modules/${name}`]?.version;
  if (!version) {
    problems.push(`${name}: not found in package-lock.json`);
    continue;
  }
  if (allow[name] !== true) problems.push(`missing allowScripts entry "${name}": true`);
}

if (problems.length) {
  console.error(
    "allowScripts is out of sync with package-lock.json:\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nnpm v12 blocks these install scripts otherwise, breaking the dev container.\n" +
      `Fix: add ${PACKAGES.map((n) => `"${n}": true`).join(", ")} to package.json ` +
      `"allowScripts" and commit it.`,
  );
  process.exit(1);
}
console.log(`allowScripts OK: ${PACKAGES.join(", ")}`);
