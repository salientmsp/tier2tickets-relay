// Guard: keep the non-production Wrangler configs honest against production.
//
// Two targets sit alongside wrangler.toml:
//   - wrangler.dev.toml   local development (`npm run dev`)
//   - [env.staging]       the staging Cloudflare tenant (`npm run deploy:staging`)
//
// Neither inherits from production. Wrangler does NOT carry `vars`, `d1_databases` or
// `queues` into an environment, and a separate config file shares nothing at all, so a
// var added to production is simply ABSENT (undefined) in both until it is added there
// too. Wrangler warns about that at deploy time; this check turns it into a build error
// so it is caught before anyone ships.
//
// It also asserts the safety posture of each target, so a copy-paste from the production
// block cannot quietly re-enable Sentry, PHI-bearing debug logs, or the "ticket created"
// email that reaches real people — and that no staging identifier still points back at
// the production tenant.
//
// Run in CI and locally (`npm run check:configs`).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Minimal TOML reader for the shape these files actually use: `[table]` / `[[table]]`
// headers and `KEY = "value"` pairs. Enough to read the vars and binding blocks without
// taking on a TOML dependency; it is not a general parser.
// Pass table === null for the top-level keys that appear before any header.
function readTable(file, table) {
  const out = new Map();
  let inTable = table === null;
  for (const raw of readFileSync(join(root, file), "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("[")) {
      inTable = line === `[${table}]` || line === `[[${table}]]`;
      continue;
    }
    if (!inTable) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

const problems = [];
const prodVars = readTable("wrangler.toml", "vars");

// Production [vars] keys intentionally not carried into a target, and why.
const OMITS = {
  dev: new Map([
    // The per-product Halo client_id is commented out in production too; locally the
    // whole pair (id + secret) lives in .dev.vars so the two halves stay together.
    ["HALO_CLIENT_ID_HUNTRESS", "set in .dev.vars alongside its secret"],
  ]),
  staging: new Map(),
};

// Settings that define each target's safe posture. A config that disagrees is a bug.
//
// dev: wrangler dev has no CF-Connecting-IP header, so an enabled allowlist rejects
//   every local request. Debug logging is ON locally because that output goes to your
//   own terminal, not to retained Workers Logs.
// staging: a deployed, internet-reachable Worker in its own tenant. It keeps
//   production's IP allowlist and token enforcement (validating that posture is the
//   point of staging), but must never email real contacts, must not mix its noise into
//   production's Sentry project, and must not persist PHI-bearing capture bodies.
const REQUIRED = {
  dev: new Map([
    ["SEND_TICKET_CREATED_EMAIL", "false"],
    ["SENTRY_ENABLED", "false"],
    ["ENFORCE_IP_ALLOWLIST", "false"],
  ]),
  staging: new Map([
    ["SEND_TICKET_CREATED_EMAIL", "false"],
    ["SENTRY_ENABLED", "false"],
    ["DEBUG_LOGS", "false"],
  ]),
};

const TARGETS = [
  { label: "dev", where: "wrangler.dev.toml", vars: readTable("wrangler.dev.toml", "vars") },
  {
    label: "staging",
    where: "wrangler.toml [env.staging.vars]",
    vars: readTable("wrangler.toml", "env.staging.vars"),
  },
];

for (const { label, where, vars } of TARGETS) {
  if (vars.size === 0) {
    problems.push(`${where} declares no [vars] at all — the config is missing or renamed.`);
    continue;
  }
  for (const key of prodVars.keys()) {
    if (vars.has(key) || OMITS[label].has(key)) continue;
    problems.push(
      `${where} is missing "${key}" (present in wrangler.toml [vars]). Wrangler does not ` +
        "inherit vars, so it would read as undefined. Add it, or record it in OMITS with a reason.",
    );
  }
  for (const [key, expected] of REQUIRED[label]) {
    const actual = vars.get(key);
    if (actual !== expected) {
      problems.push(
        `${where} ${key} must be "${expected}", got ` +
          (actual === undefined ? "no value" : `"${actual}"`) + ".",
      );
    }
  }
}

// No non-production target may point at a production resource. Local runs ignore
// database_id, but `--remote` does not; staging pointing at production's tenant, database
// or queue would be a live-data incident rather than a test.
const prodD1 = readTable("wrangler.toml", "d1_databases");
const devD1 = readTable("wrangler.dev.toml", "d1_databases");
const stagingD1 = readTable("wrangler.toml", "env.staging.d1_databases");
const prodQueue = readTable("wrangler.toml", "queues.producers").get("queue");
const stagingQueue = readTable("wrangler.toml", "env.staging.queues.producers").get("queue");
const stagingEnv = readTable("wrangler.toml", "env.staging");

const collisions = [
  ["wrangler.dev.toml", "database_id", devD1.get("database_id"), prodD1.get("database_id")],
  [
    "wrangler.toml [env.staging]",
    "database_id",
    stagingD1.get("database_id"),
    prodD1.get("database_id"),
  ],
  [
    "wrangler.toml [env.staging]",
    "database_name",
    stagingD1.get("database_name"),
    prodD1.get("database_name"),
  ],
  ["wrangler.toml [env.staging]", "queue", stagingQueue, prodQueue],
];
for (const [where, key, actual, prod] of collisions) {
  if (prod !== undefined && actual === prod) {
    problems.push(`${where} ${key} is the PRODUCTION value ("${prod}"). Give it its own.`);
  }
}

// Staging lives in a different Cloudflare account. Without an explicit account_id,
// `--env staging` publishes into whichever tenant the operator is logged into.
if (!stagingEnv.get("account_id")) {
  problems.push(
    "wrangler.toml [env.staging] has no account_id. Without it a staging deploy lands in " +
      "whatever tenant you are logged into, i.e. production.",
  );
}
if (stagingEnv.get("name") === readTable("wrangler.toml", null).get("name")) {
  problems.push("wrangler.toml [env.staging] name must differ from the production Worker name.");
}

if (problems.length) {
  console.error(
    "Wrangler configs are out of sync with production:\n" +
      problems.map((p) => `  - ${p}`).join("\n") +
      "\n\nSee the header comments in scripts/check-wrangler-configs.mjs.\n",
  );
  process.exit(1);
}

console.log(
  `Wrangler configs OK — dev and staging both cover ${prodVars.size} production vars.`,
);
