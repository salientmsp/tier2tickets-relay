# gorelo-haloapi-relay — End-to-End Audit

_Audit date: 2026-07-31. Read-only; no code changed. Where a statement is an
inference rather than something read directly in the source, it is marked
**(inferred)**._

---

## Executive summary

1. **What it is:** a single Cloudflare Worker (TypeScript, ~3,100 LoC of `src/`)
   that **impersonates a HaloPSA/HaloITSM instance** — OAuth token endpoint +
   resource server — so that apps built to push tickets into Halo instead create
   tickets in **Gorelo**. Two live integrations: **Tier2Tickets / Helpdesk
   Buttons** and **Huntress**.
2. **Hosting:** serverless Cloudflare Workers. Three runtimes in one script —
   `fetch` (HTTP), `scheduled` (two crons), `queue` (location fan-out) — backed by
   **D1** (SQLite) as a read mirror of Gorelo and **Queues** for per-client
   location sync. Designed to run on Cloudflare's **free plan** (the 50-subrequest
   cap drives much of the architecture).
3. **Dependency footprint is tiny and low-risk:** exactly **one** runtime
   dependency — `@ambersecurityinc/notifly` 0.7.1 (dead-letter alerts). Everything
   else (crypto, HTTP) is Web-platform. The niche single-org notifly package is the
   only third-party supply-chain surface worth watching.
4. **The adapter seam is real and reasonably clean:** a `PRODUCTS` registry
   (`src/products.ts`) drives IP/UA gating, per-product OAuth creds, and a couple of
   behavior flags (`deferCreate`, headings, tags). There is **very little
   copy-paste** — the two integrations share one router, one ticket-builder, one
   sync. Divergence is data, not duplicated code.
5. **But the seam only covers gating + a few knobs, not payload shape:** the
   ticket-body parser (`resolveRouting` / `buildHaloDescription`) is hardwired to
   the **Helpdesk-Buttons HTML report** shape. A third vendor with a different
   payload needs new *code*, not just config — the comments say so explicitly.
6. **Auth today:** inbound is gated by **IP allowlist (fails closed)** + optional
   **User-Agent** second gate, plus an **optional** signed-bearer-token gate
   (`HALO_TOKEN_ENFORCE`, currently `enforce` in `wrangler.toml`). Outbound to
   Gorelo is a single static `X-API-Key`. No OAuth-refresh, no per-tenant secrets
   rotation.
7. **Resilience is a notable strength:** retries with `Retry-After` honoring +
   jitter, a pending-ticket queue with grace window + attempt cap + dead-letter →
   notifly alert, delta-reconcile sync with partial-fetch safety, and a
   created-ticket ledger for idempotent verify. These are the parts most carefully
   built and best tested.
8. **Biggest structural gaps:** (a) **no replay protection / request signing** —
   IP + a bearer token minted by the same service are the only barriers; (b)
   **Gorelo has no ticket-update or attachment API**, so "resolution" and "notes"
   are emulated by filing *new* labeled tickets — an inherent fidelity gap, not a
   bug; (c) **ticket-number read-back is best-effort** and races a busy tenant.
9. **Test coverage is genuinely good** for a project this size (~2,150 lines of
   tests vs ~3,100 of source; ~130 cases) and concentrates on the scary paths
   (routing, dedup, dead-letter, enforcement, CIDR). The **thinnest** areas: the
   `GoreloClient` HTTP layer (only `retryDelayMs`/`extractTicketNumber` unit-tested,
   not pagination/error mapping against a live-ish server) and the HTML-report
   parser against malformed/adversarial input.
10. **Halo behaviors we fake:** config lookups (`/TicketType`, `/Status`,
    `/Priority`, `/Team`) return **hardcoded** option lists; `/Agent` returns
    **empty**; ticket **update** is faked as a new "Resolved:" ticket; the human
    ticket number is **reconstructed** post-hoc. `PublicTicketPriority` /
    `TicketSource` int→label mappings are unconfirmed `TODO(verify)`.

---

## 1. Inventory

### Repo structure

```
src/            Worker source (TypeScript, ES2022 modules)
  index.ts        fetch/scheduled/queue entry points + admin routes + auth helpers
  halo.ts         the Halo mock: OAuth token, resource lookups, ticket create/notes  (1,708 LoC — the core)
  products.ts     PRODUCTS registry + IP/CIDR/UA gating + per-product cred resolution
  gorelo.ts       thin Gorelo API client (retry/backoff, cursor pagination, ticket create/read-back)
  sync.ts         Gorelo→D1 delta-reconcile mirror + per-client location fan-out
  db.ts           D1 schema mgmt (self-migrating) + all point lookups
  haloShapes.ts   full Halo config-object shapes (status/type/priority/team) derived from swagger
  token.ts        signed HMAC-SHA256 bearer tokens (Web Crypto, no deps)
  parse.ts        normalizeHost / normalizeEmail
  log.ts          logging chokepoint: breadcrumb (always) vs debug (PII, gated)
  types.ts        Env + hand-written subset of Gorelo API types
test/           vitest (@cloudflare/vitest-pool-workers) — ~130 cases, 2,147 LoC
migrations/     0001_init.sql (optional; runtime initSchema is authoritative)
scripts/        gorelo-ids.sh, halo-cred.sh/.ps1 (cred provisioning), sync-swagger.py (drift)
docs/           committed swagger snapshots (gorelo v1, halo v2) + md renders
.github/workflows/  ci.yml (typecheck+test), swagger-drift.yml (nightly spec-drift PR)
wrangler.toml   Worker config: bindings, crons, queue, all [vars] (heavily documented)
```

### Languages / frameworks

- **TypeScript** targeting Cloudflare Workers (`workerd` runtime), ES2022 modules,
  `nodejs_compat` flag. Strict tsconfig (`strict`, `noUnusedLocals`,
  `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
  `verbatimModuleSyntax`, `isolatedModules`).
- **Wrangler 4.115** for dev/deploy. **Vitest 4** (workers pool) for tests.
- No web framework — routing is hand-rolled `URL.pathname` matching in `index.ts`
  and `halo.ts`.
- **Python 3** for the one CI helper (`sync-swagger.py`); **bash/PowerShell** for
  provisioning scripts.

### Build / deploy / hosting assumptions

- **Deploy:** `wrangler deploy`. Prereqs (README "Deploy"): create the D1 DB and
  paste `database_id` into `wrangler.toml`; create the `tier2tickets-sync` queue
  (deploy **fails** without it since it's bound as both producer and consumer);
  fill the Gorelo id `[vars]`; `wrangler secret put` the secrets; optionally apply
  `migrations/0001_init.sql` (or let `initSchema` self-create at runtime).
- **Hosting model:** fully serverless. **Cron triggers:** `0 */6 * * *` (mirror
  refresh via `syncAll`) and `*/5 * * * *` (orphaned-ticket flush), differentiated
  in `scheduled` by `event.cron` (`index.ts:124`). **Queue consumer** batches ≤10
  (`wrangler.toml:41`), `max_retries=3`.
- **Free-plan constraints are load-bearing:** the whole location-queue design
  exists to stay under the **50 external-subrequest per-invocation** cap
  (`wrangler.toml:29-45`, `sync.ts:120-128`).
- **Observability:** Workers Logs enabled; `invocation_logs=true` and
  `head_sampling_rate=1.0` (kept on deliberately — see wrangler.toml F4 note).

### External dependencies

| Package | Version | Type | Notes |
|---|---|---|---|
| `@ambersecurityinc/notifly` | 0.7.1 | **runtime** | Apprise-style multi-service alerting (dead-letter + sync-failure). Niche, single-org (`@ambersecurityinc`) scope, `0.x` (pre-1.0). **Only third-party runtime code shipped.** Worth watching for maintenance. |
| `wrangler` | 4.115.0 | dev | Cloudflare CLI. Current. |
| `@cloudflare/workers-types` | 5.20260730.1 | dev | Types only. Renovate-pinned to a dated build. |
| `@cloudflare/vitest-pool-workers` | 0.19.0 | dev | `0.x`, but Cloudflare-maintained. |
| `vitest` | 4.1.10 | dev | Current major. |
| `typescript` | **7.0.2** | dev | The **native (Go) TypeScript compiler** line — bleeding-edge. Pinned exact. Used for `tsc --noEmit` typecheck only, so blast radius is limited to CI. |
| Node (CI) | **26.5.1** | CI | Very new Node major, pinned in `ci.yml` and via Renovate. |

**Pinned oddly / worth noting:** Renovate is configured to **pin everything
exactly** (`rangeStrategy: "pin"`, `:pinAllExceptPeerDependencies`) with
**lock-file-maintenance automerge** (`renovate.json`). That explains the very
fresh, exact versions (TS 7, Node 26, dated workers-types) — it's deliberate, not
accidental drift. The main risk of the automerge-everything posture is a bad
transitive bump landing on `main` without review; CI (typecheck+test) is the only
gate. No unmaintained/abandoned deps detected; the footprint is unusually small.

---

## 2. Architecture

### Top-level request routing (`src/index.ts` `fetch`)

1. `/admin/sync` (POST, `ADMIN_KEY`) → `syncAll` — manual mirror refresh.
2. `/admin/status` (GET, `ADMIN_KEY`) → mirror counts + location-queue drain lag.
3. `/admin/test-webhook` (POST, `ADMIN_KEY`) → fire a notifly test alert.
4. `/health` (GET/HEAD) → `200 ok`.
5. Otherwise, if `isHaloRequest` (the `halo-app-name` header **or** a Halo-shaped
   path) → `handleHalo`. `/admin/*` and `/health` are explicitly excluded so a
   collision like `/admin/status`→`status` resource can't be routed into Halo
   (`halo.ts:113-121`).
6. Else `404`.

Admin auth (`index.ts:184-205`) accepts the key via `X-Admin-Key` / `X-API-Key` /
`Authorization: Bearer`, compared **constant-time** (length-check + XOR-accumulate).

### Full request path — the Halo mock (`handleHalo`, `halo.ts:1642`)

```
inbound → logCapture (reads body; full log only if DEBUG_LOGS)
        → ipAllowed?  (products.ts: CF-Connecting-IP ∈ enabled product IPs/CIDRs, + UA gate)  ──no──► 403 forbidden
        → [resource ≠ token] bearer-token gate  (per matched product's creds; off|observe|enforce)  ──enforce&bad──► 401 invalid_token
        → resource == token → handleToken  (validate client_id/secret, mint signed HMAC token bound to product)
          else → ensureSynced (lazy bootstrap if no last_sync) → handleApi
        → catch-all: any throw → 500 { error, request_id }  (never leaks internals; always JSON)
```

`handleApi` (`halo.ts:1591`) dispatches by normalized resource name + method:

- `POST /tickets` → `handleCreateTicket` (with `matchProduct` result)
- `GET /tickets/{id}` → `handleGetTicketById` (verify from ledger)
- `POST /actions` → `handleActions` (fold note, then create the deferred ticket)
- `GET /users|client|site|asset` → mirror-backed lookups
- `GET /tickettype|status|team|priority|agent` → `handleConfig` (hardcoded options)

**Auth.** OAuth `client_credentials` at `/token`. With a product's cred pair set,
`/token` validates `client_id`+`client_secret` and mints a **signed HMAC-SHA256**
token (`token.ts`) carrying `exp` + a `prod` claim; without creds it mints an opaque
random token (legacy-lenient). The resource gate (`HALO_TOKEN_ENFORCE`) is per
matched product and skipped for products without creds — the issue #51 design.

**Validation.** Deliberately lenient: bodies are parsed defensively
(`parseJson`→`{}` on failure, `firstTicket` tolerates arrays), unknown fields are
dumped into the description, and **every** response is guaranteed decodable JSON
because Tier2's Halo client hard-fails on any non-JSON body (`halo.ts:1678-1695`).
There is essentially **no schema rejection** of inbound tickets — by design.

**Field mapping (the heart).** `resolveRouting` (`halo.ts:616`):
- Parses the HDB **HTML "Report Summary" table** out of `details_html` for the real
  reporter identity (Tier2 files everything under `unregistered@helpdeskbuttons.com`).
- Resolves **contact** by `user_id` (ignoring the synthetic unregistered id) then by
  parsed email; **device** by hostname (exact then fuzzy); **client/location** by a
  precedence chain: matched contact → matched device → asset object's own
  client/site → non-catch-all body `client_id` → catch-all (`halo.ts:650-662`).
- Pulls the **live Gorelo agent record** for hardware/OS enrichment (best-effort).

`buildTicketCommand` (`halo.ts:1046`) maps the resolved routing + the DEFAULT_* env
ids into a `CreatePublicTicketCommand`; `buildHaloDescription` renders the report,
extra fields, and device section as **HTML** (Gorelo renders description as HTML),
escaping + linkifying throughout.

**Gorelo call + response.** `GoreloClient.createTicket` POSTs `/v1/tickets`; the
response is a bare GUID, so `resolveTicketNumber` reads the human number back off
`GET /v1/tickets` (best-effort, bounded retries). Errors become `GoreloError`
(carrying upstream status) → handler returns `502 { error: "gorelo_create_failed" }`.

### Two create flows (product-branched)

- **Tier2 (`deferCreate: false` now — eager):** despite the two-step Halo protocol,
  Tier2 is configured eager: create on `/tickets`, return the real number; the
  follow-up `/actions` note is a no-op (fallback only if the eager create failed and
  queued). The **deferred** path (`putPendingTicket` → `/actions` folds note →
  create; orphan-flush safety net) still exists in code and is exercised when a
  product sets `deferCreate: true`.
- **Huntress (`deferCreate: false` — one-shot):** whole ticket arrives in one
  `/tickets` POST → immediate create. Huntress then `GET /api/Tickets/{id}` to
  verify — served from the `created_tickets` ledger to prevent retry-dup.
  **Resolution:** Huntress signals "resolved" by *editing* the original ticket
  (a POST carrying a ledger-known id); since Gorelo can't update, the code files a
  labeled **"Resolved:" ticket** in a resolved status and marks the original
  resolved in the ledger (`handleResolution`, `halo.ts:1267`).

### Scheduled + queue paths

- `scheduled` (`index.ts:123`): `0 */6 * * *` → `syncAll`; any other cron →
  `flushPendingTickets` (orphan flush). Failures fire notifly.
- `queue` (`index.ts:156`): each message = one client's locations; fetch → 
  `reconcileClientLocations` → ack; on error `retry()` (never delete).

### Halo → Gorelo coverage matrix

**Inbound (emulated Halo surfaces the code answers):**

| Halo surface (method) | Fields consumed | Faked / ignored | Gorelo mapping |
|---|---|---|---|
| `POST /token` | `client_id`, `client_secret`, `grant_type`, `tenant`, `scope` | `grant_type`/`scope` echoed, not enforced | none — local HMAC token mint (`token.ts`) |
| `GET /Users?search=` | `search` (email or name) | most Halo user fields synthesized (`inactive`, `isserviceaccount`, `use`…) | D1 `contacts` (`findContactByEmail`/`searchContactRows`) |
| `GET /Client` (list) | `search`, `page_no`, `page_size` | `colour`, `toplevel_*` faked; `columns:[]` | D1 `clients` (`listClientRows`) |
| `GET /Client/{id}` | id | single Area object synthesized if unmirrored | D1 `clients` (`getClientName`) |
| `GET /Site?client_id=` | `client_id`, `search` | — | D1 `locations` (`listLocationRows`) |
| `GET /Asset?client_id=` | `search`, `client_id` | `inactive` faked; `id` = numeric surrogate of UUID | D1 `devices` (`searchDeviceRows`) |
| `GET /TicketType`,`/Status`,`/Priority`,`/Team` | — | **fully hardcoded** option lists (`haloShapes.ts`), all selectable flags forced true | none — static, from DEFAULT_* ids |
| `GET /Agent` | — | **always empty** `{agents:[]}` | none |
| `POST /Tickets` | `summary`/`subject`, `details_html`/`details`, `user_id`, `client_id`, `site_id`, `assets[]`, `customfields[]`, `id`/`ticket_id` (edit detect), free extras | `tickettype_id` etc. from body ignored — DEFAULT_* used instead; whole body dumped into description | `POST /v1/tickets` (`createTicket`) |
| `GET /Tickets/{id}` | id | served from ledger; 404 if unknown | D1 `created_tickets` |
| `POST /Actions` | `ticket_id`/`ticketid`/`ticket`/`request_id`, `note_html`/`note`/`outcome` | note body largely dropped; only HDB links surfaced | folds into pending → `POST /v1/tickets` |

**Outbound (real Gorelo endpoints called), `gorelo.ts`:**

| Gorelo endpoint (method) | Used for |
|---|---|
| `GET /v1/assets/agents` (cursor-paged) | fleet mirror (`listAgents`) |
| `GET /v1/assets/agents/{id}` | live device enrichment (`getAgent`, best-effort) |
| `GET /v1/clients` (cursor-paged) | client mirror (`listClients`) |
| `GET /v1/contacts` (cursor-paged) | all-contacts mirror (`listAllContacts`) |
| `GET /v1/clients/{id}/locations` | per-client site sync (`listLocations`, queue) |
| `POST /v1/tickets` | ticket create (`createTicket`) |
| `GET /v1/tickets` (cursor-paged) | human-number read-back (`resolveTicketNumber`) |

### Shared vs copy-pasted (specific)

**Genuinely shared / abstracted:**
- Product gating + cred resolution: one `PRODUCTS` registry + `matchProduct` /
  `haloCredentials` (`products.ts:64-238`). Both integrations flow through it.
- One HTTP router (`handleApi`, `halo.ts:1591`) serves both integrations.
- One ticket builder (`buildTicketCommand`/`buildHaloDescription`,
  `halo.ts:1046-972`) with product-parameterized headings/tags — not duplicated.
- One sync engine (`syncTable`/`dedupeByKey`/`reconcileClientLocations`,
  `sync.ts:335,310,259`) reused across all four mirrored tables.
- One retry/pagination client (`gorelo.ts:84-139`) for all list endpoints.
- One logging chokepoint (`log.ts`), one token impl (`token.ts`).

**Product-specific branches (data/flags, not copy-paste):**
- `deferCreate`, `ticketBodyHeading`, `ticketCreatedBy`, `tagVar`, `userAgent`,
  cred vars — all fields on the `Product` struct (`products.ts:10-52`).
- Huntress-only **resolution** handling (`handleResolution`) — but it's triggered
  by *ledger detection* (an incoming id we issued), not a hardcoded `if huntress`.
- The eager-vs-deferred split is one `if (product && !product.deferCreate)` branch
  (`halo.ts:1212`).

**Assessment:** the codebase is **not** copy-pasted per integration. The one place
that is *not* abstracted is inbound **payload parsing**: `resolveRouting` /
`parseReport` / `chosenSelections` / the default-selection regexes assume the
Helpdesk-Buttons HTML report. That's the seam a third vendor would strain (see §3).

---

## 3. The adapter seam

### Adding a third integration today (from the code + README "Onboarding")

**Config-only (no code) — the easy 60%:**
1. Add a `Product` entry to `PRODUCTS` (`src/products.ts`): key, label, exact
   `ips`/`cidrs`, `enableVar`, `defaultEnabled: false`, optional `userAgent`,
   optional cred vars, `deferCreate`, `ticketCreatedBy`, `ticketBodyHeading`,
   `tagVar`.
2. Declare the new `ENABLE_<KEY>` (and any cred/tag) vars on `Env`
   (`src/types.ts`) and in `wrangler.toml [vars]`.
3. `wrangler secret put` the client secret; set the tag id.
4. Flip `ENABLE_<KEY>="true"`.

**Code required — the hard 40% (only if the payload/lookups differ from Tier2's):**
5. Capture a real request (`DEBUG_LOGS=true`) and **write new field-mapping code**:
   `resolveRouting` and `buildHaloDescription` are Tier2/HDB-shaped. A vendor that
   sends JSON fields (not an HTML report table), different routing keys, or a
   different "emergency"/resolution convention needs branching there. The
   `wrangler.toml` and `products.ts` comments state this explicitly: *"enabling a
   product is only the IP doorman — the ticket-building path is still
   Tier2/Helpdesk-Buttons-shaped."*
6. If the vendor calls Halo config endpoints the mock doesn't yet shape correctly,
   extend `handleConfig` / `haloShapes.ts`.

**What's hardcoded (not per-product):** the DEFAULT_* Gorelo ids
(group/type/status/priority/source/catch-all client) are **global env vars**, not
per-product — every integration files into the same queue/type/status unless code
is added. The config option lists (`handleConfig`) are global. The
`unregistered@helpdeskbuttons.com` sentinel and the "this is an emergency" / default
HDB selection regexes are HDB-specific constants baked into `halo.ts`.

### How well the abstraction holds for a genuinely different vendor

| New-vendor trait | Holds up? | Why |
|---|---|---|
| **Different IP set / CIDR** | ✅ Excellent | Pure data in `PRODUCTS`; `ipInCidr` already handles ranges. |
| **API-key auth instead of OAuth** | ⚠️ Partial | The mock *is* the auth server, so it can accept anything at `/token`; but the token gate assumes an OAuth `client_credentials` shape. A vendor that sends a static API key on every resource call (no `/token` step) isn't modeled — would need a new auth branch. |
| **OAuth with refresh tokens / real IdP** | ❌ Weak | `handleToken` only does `client_credentials` and mints a fixed-TTL token; no refresh, no JWKS, no per-tenant issuer. |
| **Different payload shape (JSON, not HTML report)** | ❌ Weak | `resolveRouting`/`parseReport` are HTML-table-specific. This is the main code lift. |
| **Polling instead of webhooks** | ❌ Not modeled | Everything is inbound-push (the vendor calls *us*). There is no outbound scheduler that polls a vendor API; the only scheduled work is Gorelo→D1 sync. A polling vendor would need a whole new ingestion path (a cron that pulls, maps, and creates). |
| **Needs real ticket update/close** | ❌ Blocked upstream | Gorelo has no update API; best you can do is the "Resolved:" new-ticket emulation. |

**Verdict:** the seam is well-built **for the problem it was built for** — more
"push-a-ticket, Halo-shaped, HTML-ish body" MSP tools behind IP allowlists. It
degrades quickly outside that: different auth models, non-HTML payloads, or polling
ingestion each require new code, and the global DEFAULT_* routing ids mean even a
"config-only" onboard shares Gorelo routing with everyone else.

---

## 4. Gaps and risk (ranked by severity)

### High

- **H1 — No replay protection / request authenticity beyond IP+self-issued token.**
  The bearer token is minted by *this same service* from creds it also validates;
  there's no request signing, nonce, or timestamp check. Anyone able to source-spoof
  a Cloudflare `CF-Connecting-IP` (normally Cloudflare-controlled, so hard, but the
  allowlist can be disabled by env) or replay a captured token within its 1h TTL can
  create tickets. No idempotency key on inbound creates means a replayed `/tickets`
  POST creates a **duplicate** Gorelo ticket (the ledger only dedups Huntress's
  *verify-by-id*, not repeated fresh creates). **(partly inferred)**
- **H2 — Best-effort ticket-number read-back races.** `resolveTicketNumber`
  (`gorelo.ts:239`) matches the just-created GUID against the **first page** of
  `GET /v1/tickets` sorted by `createdOn`. On a busy tenant creating many tickets
  concurrently, the new ticket can be pushed off page 1 before read-back → the
  client is handed the **synthetic id** instead of the real number. Non-fatal
  (existence still ledgered) but user-visible.
- **H3 — Partial-failure mid-translation can silently drop a help request.** If
  Gorelo create fails repeatedly, the pending ticket is retried up to
  `MAX_PENDING_ATTEMPTS` (5) then **dead-lettered** (dropped) — the only recovery is
  the notifly alert, which is optional (`NOTIFLY_URLS` may be unset). With no alert
  configured, a dead-letter is a lost ticket logged only as a breadcrumb.

### Medium

- **M1 — Outbound Gorelo key is a single static secret, un-rotated.** One
  `GORELO_API_KEY` with write scope; compromise = full ticket-write + read across
  the tenant. No rotation mechanism in-repo.
- **M2 — Faked Halo config could mis-route on a stricter client.** `handleConfig`
  returns hardcoded type/status/priority/team; a vendor that *uses the selected id*
  (rather than letting us apply DEFAULT_*) would think it selected a real Halo
  entity that doesn't map to Gorelo. Today creation ignores the choice, so a
  vendor that expects its selection to take effect gets silently overridden.
- **M3 — `created_tickets` (and the `attempts` column) are missing from
  `migrations/0001_init.sql`.** The runtime `initSchema` (`db.ts`) creates them, so
  live deploys are fine, but the committed migration is **stale/incomplete** — a
  fresh DB provisioned *only* from the SQL file would lack the ledger. Documentation
  drift that will bite anyone who trusts the migration over the runtime.
- **M4 — Rate limiting is inbound-absent.** There's retry/backoff for *outbound*
  Gorelo calls, but **no inbound rate limit** on the Worker itself — a
  cooperating-but-buggy vendor (or a spoofed-IP flood if the allowlist is off) can
  drive unbounded Gorelo creates. Cloudflare-level rate limiting would be external.
- **M5 — Lazy bootstrap sync runs inline on the first press.** `ensureSynced` runs
  a full `syncAll` inline if `last_sync` is empty (`halo.ts:1630`). On a cold DB the
  first real ticket pays a full-mirror latency cost and risks the subrequest budget
  before the queue fan-out offloads locations. Rare (once per fresh deploy) but a
  latency cliff.

### Low

- **L1 — HTML-report parser robustness.** `parseReport`/`htmlToText` use regexes on
  attacker-influenced HTML (the report body). No catastrophic-backtracking pattern
  spotted (URL/tag regexes are bounded, trailing-slash strip is hand-rolled O(n)
  specifically to avoid it — `gorelo.ts:27-36`), but malformed/nested HTML edge
  cases are lightly tested. Output is escaped before it reaches Gorelo, so XSS into
  the ticket is mitigated.
- **L2 — `assetNum` surrogate collision risk.** Halo asset ids are derived from the
  first 12 hex of the Gorelo UUID (`sync.ts:34`). 48 bits → birthday-collision
  becomes plausible only in the millions of agents; realistically negligible but
  unbounded in theory, and a collision would mis-map an asset.
- **L3 — `DEFAULT_PRIORITY`/`DEFAULT_SOURCE` int→label mappings unconfirmed.**
  Multiple `TODO(verify)` in `types.ts`/`wrangler.toml` — the numeric priority/source
  are guesses ("2 = a middle default") not confirmed against the Gorelo UI.

### Auth/secrets, logging, idempotency — quick status

- **Secrets:** all via `wrangler secret put`, none committed; `.dev.vars.example`
  documents them; logging chokepoint redacts `Authorization`/`Cookie`/`client_secret`.
  Good hygiene.
- **Idempotency:** ledger-based for Huntress verify and resolution detection; **not**
  present for repeated fresh `/tickets` creates (see H1).
- **Replay protection:** none beyond token TTL (see H1).
- **Logging/observability:** strong — single chokepoint, PII gated behind
  `DEBUG_LOGS`, non-PII breadcrumbs always on, request-id correlation on 500s,
  invocation logs deliberately on, notifly alerts on dead-letter + sync failure.
- **Retries:** outbound honors `Retry-After` + jitter, capped; queue messages retry
  with backoff; pending tickets retry with a grace-window backoff and attempt cap.

### Test coverage

- **~130 cases, `test/halo.test.ts` alone is 1,458 lines.** Well covered: routing
  precedence, catch-all fallback, dedup stability, delta-reconcile idempotency,
  partial-fetch (no contact deletes), >100-row delete chunking, cursor pagination,
  dead-letter + notifly, orphan-flush single-attempt-per-run, IP/CIDR/UA gating
  (fail-closed), token sign/verify + per-product enforcement (#51), emergency
  priority, resolution notice, verify-GET-from-ledger, method guards, `/admin/status`.
- **Thinnest / scariest untested paths:**
  - **`GoreloClient` HTTP behavior** beyond `retryDelayMs`/`extractTicketNumber`:
    `getAllPages` cursor edge cases, `getJsonWithRetry` exhaustion → `GoreloError`
    mapping, and the `resolveTicketNumber` **race** (H2) are not directly tested.
  - **`resolveTicketNumber` miss handling** is tested at the handler level ("still
    creates when read-back finds no match") but not the busy-tenant race itself.
  - **HTML parser against adversarial/malformed input** (deeply nested tags,
    unterminated tags, huge blobs beyond `BODY_MAX`) — light.
  - **Lazy inline bootstrap** (`ensureSynced`) subrequest-budget behavior on a cold
    DB — not exercised.
  - **Concurrent/duplicate inbound creates** (idempotency, H1) — not tested.

### Halo behaviors we stub / no-op / fake-success

- **Config lists** (`/TicketType`, `/Status`, `/Priority`, `/Team`) — hardcoded.
- **`/Agent`** — always empty success.
- **Ticket update/close** — faked as a new "Resolved:" ticket + ledger flip; the
  original Gorelo ticket is never actually updated (upstream limitation).
- **Human ticket number** — reconstructed post-hoc, best-effort, may be synthetic.
- **`/Actions` note body** — accepted with `201` but largely discarded (only HDB
  links surfaced); for eager Tier2 it's effectively a no-op success.
- **Unregistered user** — synthetic id `999999999` → catch-all client, always
  "resolves" to a fabricated Halo user object.
- **Every error** is coerced to decodable JSON (never a real 5xx HTML page) so the
  Halo client keeps working — a deliberate fake-success-shaped-response posture.

---

## 5. Open PR / issue digest

_Data pulled from GitHub 2026-07-31 (read-only)._

### Open PRs (4)

| # | Title | Author | Age | Kind |
|---|---|---|---|---|
| 83 | Refresh lock file | renovate[bot] | today | dep bot (automerge, immortal) |
| 82 | Update dependency wrangler to v4.116.0 | renovate[bot] | 1d | dep bot |
| 81 | Update dependency @cloudflare/vitest-pool-workers to v0.19.1 | renovate[bot] | 1d | dep bot |
| **77** | **Mirror Huntress alerts into a co-managed client's Jira** | **00o-sh** | **2d** | **human feature** |

- **#81/#82/#83** are all Renovate and all touch `package-lock.json`, so they
  **conflict with each other** on merge order (Renovate auto-rebases the losers).
  They're complementary (wrangler bump / vitest-pool bump / general lock refresh),
  not duplicates; all tracked by the Dependency Dashboard (#64). None stale.
- **#77 is the important one — and it is effectively the "third integration" this
  audit was scoping.** +1,092/−11 across 12 files, `mergeable_state: clean`, no
  reviews in ~2 days. It adds an **outbound Jira Cloud** fan-out: when a Huntress
  alert creates a Gorelo ticket, also create a Jira issue in an enrolled client's
  project, and close it (comment + transition) on Huntress resolution. New
  `src/jira.ts` (dependency-free client), a `pending_jira` durable queue drained by
  the `*/5` cron with dedup + notifly dead-letter, schema **v4** (`pending_jira`
  table + `jira_issue_key` column), `migrations/0002_jira_fanout.sql`, per-client
  enrollment via a `JIRA_TARGETS` secret gated behind `ENABLE_JIRA` (off by
  default). Claims 133 tests green.
  - **Cross-reference to the architecture:** #77 is a **different shape** of
    integration than the seam in §3 was built for. It is **outbound** (the relay
    calls Jira), uses **Jira's own OAuth/API-token auth** (not the Halo mock), and
    is **event-driven off the Gorelo-create path** rather than an inbound Halo
    caller. It validates the §3 finding that the current `PRODUCTS`/`matchProduct`
    seam does **not** generalize to non-Halo, non-inbound vendors — #77 correctly
    does **not** try to reuse it, instead adding a parallel subsystem
    (`jira.ts` + `pending_jira`) alongside. It also reuses the good bones:
    the durable-pending-queue + cron-flush + dead-letter pattern from
    `pending_tickets`, and the schema-versioned `initSchema` migration approach.
  - It does **not** conflict with the Renovate PRs (different files). It is the
    only substantive open feature; nothing duplicates it.

### Open issues (2)

| # | Title | Author | Labels | Theme |
|---|---|---|---|---|
| 64 | Dependency Dashboard | renovate | — | dep-maintenance (bot control panel) |
| 34 | Gorelo API ignores `sendTicketCreatedEmail` — requester email never sends | 00o-sh | — | **upstream Gorelo API defect** |

- **#64** is Renovate's bookkeeping issue (lists #81/#82/#83 + detected deps). Not
  a bug.
- **#34** tracks a **confirmed upstream Gorelo bug**: `POST /v1/tickets` accepts
  `sendTicketCreatedEmail: true` but never sends the confirmation email (reproduced
  in Gorelo's own Swagger UI). The relay side is correct; no relay fix expected —
  it's a vendor-owned blocker to track.

**Themes:** (1) dependency maintenance (bot) — #64 ↔ #81/#82/#83; (2) upstream
vendor API defects — #34. The two issues share no root cause. #34 is the only real
product issue open.

### Recent closed PRs (last 20)

- **18 merged, 2 abandoned (closed unmerged), 0 reverted.**
- **Abandoned #58 & #59** — both human-authored dependency-**security** fixes via
  npm `overrides` (`sharp`/libvips CVEs; `postcss` path-traversal), both targeting
  **transitive dev-toolchain** deps. Closed at the same instant with **no comment**,
  immediately after the Renovate onboarding PRs merged. Strong inference: **superseded
  when Renovate took over dependency management** — the `overrides` approach was
  dropped in favor of Renovate's pinning/lock-maintenance. **Risk flag:** if
  Renovate's pinned lockfile doesn't actually force those transitive deps past the
  vulnerable versions, the CVEs that #58/#59 targeted may be **silently
  unaddressed**. Worth a one-time `npm audit` confirmation. **(inferred — the
  abandonment reason is not stated in-thread.)**
- Notable recent human merges show where the code has been actively evolving —
  all in the ticket-body / product-seam area: **#76** per-product submission tags +
  API fallback, **#75** hyperlink/customfields cleanup, **#72** vitest timeout
  de-flake, **#70** Halo swagger drift-sync, **#61** Huntress report formatting +
  incident resolution. This corroborates §2: the product seam and HTML-body
  handling are the churn hotspots.

### Which reported problems are structural vs one-off

- **#34** is **not** structural to the relay — it's upstream. But it exposes a
  structural truth from §4/M2: the relay **cannot guarantee side effects it delegates
  to Gorelo** (emails, and by extension updates/closes). Any feature that depends on
  Gorelo doing something the relay can't verify is on shaky ground.
- **#58/#59 abandonment** is a **process** structural point, not a code bug: the repo
  now relies entirely on Renovate + CI for supply-chain safety, with automerge on
  lock maintenance. That's the single point of failure for dependency security (§1).
- **PR #77's existence** is the clearest structural signal: the team is already
  extending *past* the Halo-inbound model, and the codebase accommodated it by
  adding a **parallel** subsystem rather than extending `PRODUCTS` — confirming the
  seam's scope limits from §3.

---

## 6. Candidate next integrations

For each, the Halo surfaces (or other ingestion) it would need beyond today's
coverage, and rough effort. Effort scale: **S** = config + minor branch, **M** =
new field-mapping/handler code within existing patterns, **L** = new subsystem.

| Candidate | What it needs beyond today | Effort |
|---|---|---|
| **Another Halo-inbound MSP tool with an HTML/report-ish body** (e.g. a different RMM's Halo connector) | `PRODUCTS` entry (IPs/UA/creds) + likely a **body-parser branch** in `resolveRouting`/`buildHaloDescription` if the report shape differs from HDB. Config lists already faked. | **S–M** |
| **A Halo-inbound tool that sends structured JSON tickets (not an HTML table)** | New `resolveRouting` branch keyed on product for JSON field extraction; possibly per-product DEFAULT_* routing ids (today they're global). No new auth. | **M** |
| **PR #77's Jira mirror (already in flight)** | Outbound Jira client + per-client enrollment + durable pending queue + resolution transition. Halo surfaces: **none new inbound** — it hangs off the existing Huntress create/resolution events. | **M** (mostly built) |
| **A vendor using static API-key auth on every call (no OAuth `/token` step)** | New auth branch: accept + validate a per-product API key on resource requests instead of the `client_credentials`→bearer flow. `token.ts` unaffected; `handleHalo` gate needs a per-product auth-mode switch. | **M** |
| **A polling vendor** (we pull alerts from *their* API on a schedule) | Whole new **ingestion path**: a cron that polls the vendor, maps payloads, and creates Gorelo tickets — plus cursor/watermark state in D1 to avoid re-ingesting. Reuses `GoreloClient.createTicket` + the pending/ledger patterns but is a **new subsystem** like #77. | **L** |
| **A vendor requiring real bi-directional ticket sync (updates/closes reflected in Gorelo)** | **Blocked upstream** — Gorelo has no ticket-update API. Would need either Gorelo to add one, or the "new Resolved: ticket" emulation extended (low fidelity). Not a relay-only lift. | **L / blocked** |
| **Real OAuth/IdP-fronted vendor (refresh tokens, JWKS)** | `handleToken` today only does fixed-TTL `client_credentials`. Would need refresh-token issuance, rotation, possibly per-tenant issuers. | **L** |

**Recommendation implied by the findings (not a directive):** the cheapest, most
on-model next integrations are more **Halo-inbound push tools**; the seam already
carries them at **S–M**. Anything **outbound** (like #77) or **polling** is an **L**
new subsystem — plan for a parallel module, not a `PRODUCTS` row. Before adding a
third *inbound* product, consider promoting the **DEFAULT_* routing ids to
per-product** (today's global ids mean every integration shares one
group/type/status), and factoring the HDB-specific body parser out of
`resolveRouting` into a per-product mapper — that single refactor is what would move
"different payload shape" from **M** back toward **S**.

---

## Appendix — method & confidence

- **Read directly (high confidence):** all of `src/` (every file in full),
  `wrangler.toml`, `package.json`, `tsconfig.json`, `renovate.json`, both CI
  workflows, `migrations/0001_init.sql`, `.dev.vars.example`, and the relevant
  README sections. Open/closed PR + issue metadata via the GitHub API.
- **Inferred (flagged inline):** the #58/#59 abandonment reason (no in-thread
  explanation), the replay/spoofing exploitability of H1 (depends on deployment
  config), and effort estimates in §6. PR #77's internals are summarized from its
  description/diff stat, not a line-by-line read of its branch.
- **Not done:** did not run the test suite or deploy; did not read the full 35 KB
  README or the swagger snapshots line-by-line; did not audit PR #77's branch code
  directly.
