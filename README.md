# gorelo-haloapi-relay

A Cloudflare Worker that **impersonates a HaloPSA/ITSM instance** so that products
with a **HaloPSA integration** can create tickets in **Gorelo** — a PSA those
products don't natively support. It speaks the Halo API dialect on the front and
the Gorelo API on the back, translating between them.

> Formerly `tier2tickets-relay` (Tier2Tickets / Helpdesk Buttons was the first and
> original product). It now fronts **multiple** Halo-integration products, so the
> name is generic; Tier2 wording below is kept where a behavior is Tier2-specific.

**Supported products** (each gated + handled independently — see [Products](#products)):

| Product | Source | Ticket create |
|---|---|---|
| **Tier2Tickets / Helpdesk Buttons** | 2 fixed IPs | two-step: `POST /tickets` then a `/actions` note (**deferred** create) |
| **Huntress** | its source IPs/CIDRs + `User-Agent: Huntress Halo Integration` | one-shot: everything in `POST /api/Tickets` (**immediate** create) |

A product runs its Halo integration against the Worker: it authenticates (OAuth2),
looks up the user / company / site / asset, and creates the ticket. The Worker
answers those lookups from a **D1 mirror of Gorelo** and maps the create back to a
real Gorelo ticket — resolving the correct client, contact and asset, then packing
the report/details into the ticket body. The Halo lookup responses are shaped
faithfully to the real Halo API (envelopes + full objects, derived from
[`docs/halo-swagger.v2.json`](docs/halo-swagger.v2.json)) so a strict Halo client
doesn't choke on them.

> An earlier version also mocked **osTicket** (create-only). That path has been
> removed — Halo is the sole integration, because it's the only one that lets
> these products do the PSA lookups (contact/company/asset matching) we need.

## How it works

```
Helpdesk Buttons ──Halo API (OAuth + lookups + create + note)──▶  Worker  ──▶ Gorelo POST /v1/tickets
   (Tier2 cloud, 2 fixed IPs)                                       │
   POST /token                                                      ├─ answer user/client/site/asset lookups from the D1 mirror
   GET  /users /client /site /asset                                 ├─ POST /tickets: resolve routing, QUEUE the command
   POST /tickets                                                    ├─ POST /actions: fold in report links, CREATE the Gorelo ticket
   POST /actions (report note)                                      └─ orphan flush creates any press whose note never arrives

Cron (every 6h) / POST /admin/sync / first-call bootstrap ──▶ syncAll() delta-reconciles the D1 mirror
```

- Requests are recognized as Halo calls by the `halo-app-name` header (Tier2) **or**
  the path shape (`/token`, `/users`, `/tickets`, or the `/api/*` forms Huntress
  uses) — no header required for the path form.
- The Worker **always** returns decodable JSON — a Halo client fails hard on any
  non-JSON body, so every handler is wrapped to emit JSON even on error.
- On a Gorelo create failure the `/actions` call returns **502** (with the upstream
  status) so Tier2 surfaces a failure instead of silently dropping the ticket.

## Project layout

| Path | Purpose |
|---|---|
| `src/index.ts` | `fetch` + `scheduled` handlers, routing (admin/health/Halo) |
| `src/halo.ts` | the HaloPSA mock — token, lookups, per-product create, report parsing |
| `src/products.ts` | product registry (`PRODUCTS`, IPs/CIDRs, `ENABLE_*`, UA gate, `matchProduct`, `ipAllowed`) |
| `src/haloShapes.ts` | full Halo config-item shapes (status/type/priority/team), field lists derived from the swagger |
| `src/gorelo.ts` | Gorelo API client (retry/backoff, defensive parsing) |
| `src/sync.ts` | `syncAll()` — rebuild the D1 mirror off the request path |
| `src/db.ts` | D1 schema + point lookups (+ the deferred-ticket queue) |
| `src/parse.ts` | small string normalizers (`normalizeHost`, `normalizeEmail`) |
| `src/types.ts` | `Env` + hand-written subset of Gorelo API types |
| `docs/halo-swagger.v2.json` | the real HaloPSA OpenAPI spec — reference for shaping mock responses |
| `migrations/0001_init.sql` | D1 schema (also self-created at runtime) |
| `scripts/gorelo-ids.sh` | dump groups/types/statuses/clients to fill the vars |
| `test/` | vitest specs (`@cloudflare/vitest-pool-workers`) |

## Deploy

```bash
npm install

# 1. Create the D1 database and paste the returned id into wrangler.toml
wrangler d1 create tier2tickets-relay
#   -> copy database_id into [[d1_databases]] in wrangler.toml

# 2. Apply the schema (optional — the Worker self-creates tables too)
wrangler d1 migrations apply tier2tickets-relay          # remote
wrangler d1 migrations apply tier2tickets-relay --local  # for `wrangler dev`

# 2b. Create the location-sync queue (one-time; syncAll fans location fetches
#     out to it, a queue consumer reconciles them per client). Deploy fails
#     without it since wrangler.toml binds it as a producer + consumer.
wrangler queues create tier2tickets-sync

# 3. Fill the Gorelo IDs in wrangler.toml [vars]
GORELO_API_KEY=xxxx ./scripts/gorelo-ids.sh
#   -> set DEFAULT_GROUP_ID, DEFAULT_TYPE_ID, DEFAULT_STATUS_ID, DEFAULT_PRIORITY,
#      DEFAULT_SOURCE, CATCHALL_CLIENT_ID, HDB_TAG_ID, EMERGENCY_PRIORITY, DEBUG_LOGS,
#      HALO_TOKEN_ENFORCE (off|observe|enforce — see Security)

# 4. Set secrets (never committed)
wrangler secret put GORELO_API_KEY     # X-API-Key for Gorelo (ticket write + asset/contact/client read)
wrangler secret put ADMIN_KEY          # gates POST /admin/sync
wrangler secret put HALO_CLIENT_ID     # optional: Halo mock OAuth client_id  (validated if both set)
wrangler secret put HALO_CLIENT_SECRET # optional: Halo mock OAuth client_secret

# 5. Deploy
wrangler deploy

# 6. Seed the D1 mirror (or wait for the first cron / first call to bootstrap it)
curl -X POST https://<your-worker-host>/admin/sync -H "X-Admin-Key: <ADMIN_KEY>"
```

For local development, copy `.dev.vars.example` to `.dev.vars` (git-ignored) and
run `wrangler dev`.

## Helpdesk Buttons portal setup

Configure Tier2 as a **HaloPSA — Cloud Hosted** integration:

1. **Integration type:** HaloPSA / HaloITSM (Cloud Hosted).
2. **Resource Server *and* Authorization Server:** both = your Worker host
   (e.g. `https://tier2tickets-relay.<subdomain>.workers.dev`).
3. **API key:** the `tenant+client_id:client_secret` credential. If you set
   `HALO_CLIENT_ID`/`HALO_CLIENT_SECRET`, the token endpoint validates them;
   otherwise any credentials are accepted. (The on-prem `client_id:client_secret`
   form is tolerated too.)
4. Press **Integration Test** / do a real press — the Worker answers the OAuth +
   lookup + create + note sequence, and a Gorelo ticket appears.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `/token`, `/users`, `/client`, `/site`, `/asset`, `/tickets`, `/actions`, … (and `/api/*` forms) | product allowlist (enforced by default) + optional bearer-token gate — see [Security](#security); recognized by the `halo-app-name` header or the path shape | HaloPSA mock (see below) |
| `POST /admin/sync` | `X-Admin-Key` / `X-API-Key` / `Authorization: Bearer` = `<ADMIN_KEY>` | Refresh the D1 mirror on demand (fans location fetches out to the queue) |
| `GET /admin/status` | `ADMIN_KEY` (same as `/admin/sync`) | Pretty JSON: mirror row counts, `lastSync`, and `locationQueue` (`queued` / `drained` / `lagSeconds`) — follow the location fan-out |
| `POST /admin/test-webhook` | `ADMIN_KEY` (same as `/admin/sync`) | Fire a test alert through the dead-letter webhook and report its HTTP status |
| `GET`/`HEAD` `/health` | none | Liveness check (accepts `HEAD` for uptime monitors) |

A recognized path hit with the wrong method returns `405` with an `Allow` header
naming the right one (not a misleading `404`). Anything else returns `404`.

## HaloPSA/ITSM mock (`src/halo.ts`)

Lookup responses mirror the **real Halo API shapes** (`docs/halo-swagger.v2.json`):
list endpoints use the `*_View` **paging envelope** (`page_no`/`page_size`/`record_count`/
`columns` + the entity array) and config lookups return **bare arrays of full objects**
— a strict Halo client (Huntress) deref's many fields and paginates, so thin
`{id,name}` responses crash it.

| Halo call | Worker response |
|---|---|
| `POST /token` (client_credentials) | validates `HALO_CLIENT_ID/SECRET` (if set) and returns a bearer token — a signed HMAC token when creds are set, else an opaque one. Enforcement on the endpoints below is governed by `HALO_TOKEN_ENFORCE` (see [Security](#security)) |
| `GET /users?search={email}` | the Gorelo **contact** (id/name/email/client/site) in the `Users_View` envelope; the `unregistered@helpdeskbuttons.com` catch-all maps to `CATCHALL_CLIENT_ID` |
| `GET /client` / `GET /site` | Gorelo **clients** / **locations** from the mirror (`Area_View` / `Site_View` envelope) |
| `GET /client/{id}` | a **single** Halo `Area` object (not the list envelope) — name from the mirror, synthesized for an unmirrored id (e.g. the catch-all) |
| `GET /asset?search={hostname}` | the Gorelo **agent/device** (numeric surrogate id ↔ agent UUID) in the `Device_View` envelope |
| `GET /tickettype\|status\|team\|priority` | **full-shape** bare arrays (`src/haloShapes.ts`); `status` returns an open→closed set so a PSA editor's closed-status mapping resolves |
| `POST /tickets` (or `/api/Tickets`) | build the Gorelo command, then create **per product** (below). Accepts a single object or a Halo-style array |
| `POST /actions` | folds the report links into the queued command, then **creates** the Gorelo ticket (Tier2 two-step path) |

**Per-product create** (branched on `matchProduct`, `src/products.ts`):

- **Deferred (Tier2, `deferCreate: true`):** Tier2 posts the ticket, then the report as
  a separate `/actions` note. Gorelo has no ticket-append endpoint, so `/tickets` queues
  the command in `pending_tickets` and the `/actions` note creates the single Gorelo
  ticket. A press whose note never arrives is created by an orphan flush (the
  `*/5 * * * *` cron, plus an opportunistic sweep off live requests) after
  `PENDING_GRACE_MS`.
- **Immediate (Huntress, `deferCreate: false`):** the whole ticket arrives in the one
  POST and there's no follow-up note, so the Gorelo ticket is created **right away**
  (falling back to the pending queue if that call fails, so the orphan flush retries).
  The submitter name and body heading are product-aware (Huntress → `"Huntress"` /
  `"Details"` instead of the HDB `"Helpdesk Buttons"` / `"Report Summary"`).

**Dead-letter (both paths):** a command that keeps failing to create is **dead-lettered**
(logged + dropped) after `MAX_PENDING_ATTEMPTS`, so it can't retry forever — and if
`NOTIFLY_URLS` is set, an alert is sent via [notifly](https://github.com/ambersecurityinc/notifly)
(Apprise-style URLs — ntfy / Teams / Slack / Discord / email / …) with the ticket
detail (client/contact/title/description) so a tech can recreate the lost press. Set
one or more comma/space-separated URLs; verify wiring anytime with
`POST /admin/test-webhook`. For a **Teams Workflows** (Power Automate) webhook, use
the `workflows://` scheme — take the generated URL and swap `https` → `workflows`
(the `sig` token is preserved). The notifly
[Playground URL builder](https://notifly.sh/docs/builder/playground/) will do this
conversion for you (it runs entirely client-side — the URL/`sig` never leaves your
browser). notifly drops the message `type`, so severity rides in the title/body.

**Reporter routing:** Tier2 files every press under the hardcoded
`unregistered@helpdeskbuttons.com` user → the catch-all client, so the real identity
lives only in the `details_html` "Report Summary" table. The Worker parses it and
resolves the actual Gorelo **contact** (by reporter email — real client contacts
only; no auto-create) and **asset/client/location** (by hostname, exact then fuzzy);
the ids Tier2 sends are used only as a last-resort fallback.

**Ticket body (HTML):** the description is HTML (Gorelo renders it as such). It has a
**Report Summary** (fields + non-default selections as bullets — the two always-on
defaults are stripped), a **Device** section pulled live from the Gorelo agent record
(`GET /v1/assets/agents/{id}`: model, CPU, memory, OS, serial, IPs, last user, and
last-boot shown as a relative age using the agent's `timeZone`), and the **View
Report** link (screenshots/diagnostics). The routing outcome is logged, not shown.

**Priority:** a press flagged "This is an emergency" is created at `EMERGENCY_PRIORITY`
(else `DEFAULT_PRIORITY`).

**Known limitation — the ticket number echoed back is not the Gorelo ticket
number.** For **every** product, the create response returns a synthetic id — the
`haloId` in `src/halo.ts`, a surrogate of a random UUID — **not** the number Gorelo
assigns. So anything that shows or checks it (Tier2's "Help Data Delivered" screen,
Huntress's ticket link) gets the random mock, never a real number. Why:
- Gorelo's `POST /v1/tickets` returns only `{ "ticketId": "<uuid>" }` — an internal
  id, **no** human-readable ticket number — and there's no GET-ticket / list-tickets
  endpoint to read a number back or to *check* a ticket afterward.
- For deferred products (Tier2) the real Gorelo ticket isn't even created until the
  `/actions` note arrives, so there's nothing to return at `POST /tickets` time.

The immediate path (Huntress) creates the ticket in-line but still only receives that
`ticketId` uuid — not a displayable number — and returns the `haloId` mock regardless,
so both products are in the same spot. Gorelo has indicated an API update exposing the
created ticket number is expected within ~a month; a full fix also needs a
`GET /api/Tickets/{id}` that resolves the real ticket to check it. The Gorelo-side
ticket itself is created correctly — only the number echoed back is a placeholder.
Tracked in [#35](https://github.com/salientmsp/tier2tickets-relay/issues/35).

**Requester email:** Gorelo's "ticket created" email is suppressed by default
(`sendTicketCreatedEmail=false`). Set `SEND_TICKET_CREATED_EMAIL=true` to enable it —
but the Worker still only asks for it when it **resolved a real client contact**
(`contactId`). A press that falls back to the catch-all client (no contact match)
never sends the email, so it can't notify the wrong party.

> **Known Gorelo bug:** even with the flag set, Gorelo currently **ignores**
> `sendTicketCreatedEmail` and sends no email (reproduced in Gorelo's own Swagger UI).
> The relay sends the flag correctly; the fix is upstream. Tracked in
> [#34](https://github.com/salientmsp/tier2tickets-relay/issues/34).

**ID mapping:** Halo `client_id`/`site_id`/`user_id` *are* the Gorelo client / location
/ contact ids (the lookups return them). Assets use a deterministic numeric surrogate
of the agent UUID (`asset_num`, stored in D1), mapped back on create.

**Tagging:** every HDB ticket gets the Gorelo tag `HDB_TAG_ID` (31974 "Submitted VIA
HDB") via `tagIds`, for filtering/reporting. This is a tag, not the ticket type
(`DEFAULT_TYPE_ID` stays 7045 "Incident").

**Attachments (screenshots / diagnostic data):** the binaries are **not** sent to us.
HDB hosts the full report and the remote session on its own portal and only sends
hyperlinks, which we surface in the ticket. Gorelo's public API has no attachment
endpoint, so linking is the only way to reach that content from a ticket.

**Logging:** by default only non-PII breadcrumbs are logged (method/path/status +
resolved ids in the `HALO routing:` line). Set `DEBUG_LOGS=true` to log full
`HALO CAPTURE` / `HALO RESPONSE` bodies (which contain PII/PHI — names, emails,
phones) for a short debugging window, then turn it back off.

## Products

Each upstream product is a `Product` entry in the `PRODUCTS` registry
(`src/products.ts`):

```ts
interface Product {
  key: string;              // "tier2" | "huntress"
  label: string;
  enableVar: keyof Env;     // ENABLE_TIER2 | ENABLE_HUNTRESS
  defaultEnabled: boolean;  // value when the flag is unset (tier2 on, huntress off)
  ips: Set<string>;         // exact source IPs
  cidrs: string[];          // IPv4 CIDR ranges
  userAgent?: string;       // optional UA second gate (IP AND UA when set)
  deferCreate: boolean;     // true = two-step /tickets+/actions; false = immediate
  ticketCreatedBy: string;  // submitter-name fallback
  ticketBodyHeading: string;// heading over the pasted ticket body
}
```

`matchProduct(request, env)` is the seam: it returns which **enabled** product a
request's IP (+ UA) belongs to, and the create path and body-building branch on it.
Gating and per-product create are covered under [Security](#security) and the
[mock](#halopsaitsm-mock-srchalots) above.

**Onboarding a new product:**

1. Add a `Product` to `PRODUCTS` (its IPs/CIDRs, an `ENABLE_<KEY>` flag with
   `defaultEnabled: false`, and — if it self-identifies — a `userAgent`).
2. Declare the flag on `Env` (`src/types.ts`) and in `wrangler.toml [vars]`.
3. Capture a real request (`DEBUG_LOGS=true` briefly) and, if its ticket payload or
   lookups differ from Tier2's, branch the handling on the matched product. Shape any
   new Halo responses against `docs/halo-swagger.v2.json` (list endpoints need the
   `*_View` paging envelope; config lookups need full objects, not `{id,name}`).
4. Flip `ENABLE_<KEY>="true"` when ready.

> **Single Halo credentials (planned: per-product):** `HALO_CLIENT_ID`/
> `HALO_CLIENT_SECRET` are one pair for the whole Worker. With them set and
> `HALO_TOKEN_ENFORCE="enforce"`, only tokens minted for *that* client validate — so
> multiple products with **different** OAuth credentials can't all pass token
> enforcement at once (e.g. Huntress authenticates with a different `client_id` than
> Tier2). **Interim:** run `HALO_TOKEN_ENFORCE` at `off`/`observe`, or leave the Halo
> OAuth secrets unset (any credentials accepted) — do **not** run `enforce` with the
> secrets set while more than one product is enabled. Moving to per-product
> credentials is planned work — tracked in
> [#51](https://github.com/00o-sh/gorelo-haloapi-relay/issues/51).

## Data store & refresh

Gorelo's agent/client lists have no server-side filters, so they're mirrored into
**D1** for indexed point lookups per press — never pulled on the request path.

- **Cron Triggers** (`crons = ["0 */6 * * *", "*/5 * * * *"]`): the 6-hourly cron runs
  `syncAll()`; the frequent cron flushes orphaned deferred tickets. Differentiated
  in `scheduled` by `event.cron`.
- **Manual** `POST /admin/sync` (gated by `ADMIN_KEY`) for post-onboarding refresh.
- **Lazy bootstrap** — on the first Halo call ever (no `last_sync` row), `syncAll()`
  runs once inline so a fresh deploy self-heals.
- `syncAll()` mirrors clients, **all contacts (one bulk `GET /v1/contacts`)** and
  the agent fleet (rich device rows with `asset_num`) inline, then **fans location
  fetches out to a queue** (see below). It **delta-reconciles** each table rather
  than rewriting it: every fetched row is upserted with an `ON CONFLICT … DO UPDATE
  … WHERE <columns differ>` guard (so unchanged rows write nothing), then only rows
  that vanished upstream are deleted. D1 writes per sync scale with actual churn,
  not fleet size — a no-change sync costs ~0 writes. (Devices upsert on a unique
  `agent_id` index; the other tables on their integer primary key.)
- **Subrequest budget & the location queue** — a Worker invocation has a hard cap
  of **50 external `fetch` subrequests** (free plan; D1 and other Cloudflare
  bindings are on a separate 1,000 budget and don't count). Agents/clients/contacts
  are three bulk calls, but **locations have no bulk endpoint** — one `fetch` per
  client — so an inline all-clients sweep (× retries) blew the 50 cap at scale.
  Instead `syncAll()` enqueues one `SYNC_QUEUE` message per client and a **queue
  consumer** (`queue()` in `src/index.ts`) fetches locations in batches of ≤10, so
  each consumer invocation makes ≤10 Gorelo calls — well under 50 — and per-message
  retry with backoff replaces the hand-rolled retry loop. Queues are on the free
  plan. The idempotent schema migrations are also gated behind a `schema_version`
  row in `sync_meta` (steady-state `initSchema` is a single version-check read).
- **Location reconcile is per-client** — each queue message refreshes and
  reconciles exactly one client's sites (`reconcileClientLocations`): upsert its
  locations, delete only that client's stale rows. No global snapshot needed, so
  fanning out across invocations is safe. `syncAll()` also drops locations of any
  client that vanished upstream (inline, D1-only).
- **Partial-fetch safety** — if the bulk contacts fetch fails, contacts are
  **upsert-only that run (no deletes)** so rows we failed to fetch aren't dropped;
  a later complete sync reconciles them. A failed location message **retries**
  (never deletes) and is dropped after `max_retries`, to be re-enqueued next sync.
  Rows are deduped by key with a deterministic winner so a duplicate id in a feed
  doesn't flip-flop the row each run.
- **Observability** — `syncAll()` returns `changed`/`deleted` (inline tables),
  `locationsQueued`, and `complete` (bulk fetches succeeded). All are logged by the
  cron; the `POST /admin/sync` response echoes the counts plus `locations_queued=N`
  and appends `(partial: …)` when the contacts fetch failed. The queue consumer
  logs per-client `changed`/`deleted`. To **follow the location fan-out**: `GET
  /admin/status` (mirror counts + `enqueued`/`lastConsumerRunAt`/`drained`),
  `wrangler tail` for live consumer logs, or the Cloudflare dashboard → Queues →
  `tier2tickets-sync` for backlog/throughput.
- **Failure alerts** — if a sync throws (cron, `POST /admin/sync`, or the lazy
  bootstrap), it fires the configured notifly webhook(s) (`NOTIFLY_URLS`, the same
  path as dead-letter alerts) so a stale mirror doesn't degrade silently. No-op
  when `NOTIFLY_URLS` is unset.

## Security

- **Product allowlist (fails closed):** the allowlist is **ENFORCED by default** —
  only the source IPs (and CIDR ranges) of the **enabled products** may reach the
  Halo mock, matched on `CF-Connecting-IP`. Products live in the `PRODUCTS` registry
  (`src/products.ts`), each with its exact IPs/CIDRs, an `ENABLE_<PRODUCT>` toggle,
  and an optional **User-Agent second gate** (a request must match the product's IP
  **and**, when set, its `User-Agent` — IP is always required, so UA only tightens,
  never widens; Huntress requires `Huntress Halo Integration`). `matchProduct()`
  returns which enabled product a request came from (the hook per-product handling
  branches on); `ipAllowed()` is a thin wrapper over it.
  - `ENABLE_TIER2` / `ENABLE_HUNTRESS` (`"true"`/`"false"`): an **unset** flag falls
    back to the product's built-in default — **tier2 on, huntress off** — so a
    missing var can't silently flip behavior. If **every** product is disabled the
    allowlist fails closed (rejects all).
  - The whole allowlist is disabled **only** by an explicit, normalized
    `ENFORCE_IP_ALLOWLIST` of `false`, `0`, or empty; an unset var, `true`, or any
    other value enforces. An absent `CF-Connecting-IP` header also fails closed.
- **OAuth credentials → token enforcement:** setting `HALO_CLIENT_ID`/`HALO_CLIENT_SECRET`
  makes `/token` validate them **and** mint a signed HMAC-SHA256 bearer token
  (`payload.sig`, keyed by `HALO_CLIENT_SECRET`, with an `exp` claim; Web Crypto,
  no new dependency). Whether that token then **protects the resource endpoints**
  depends on `HALO_TOKEN_ENFORCE` (the gate is a no-op unless both credentials are
  set, and never applies to `/token`):
  - `off` (**default**) — no token check on resource endpoints. The credentials
    gate `/token` issuance only; they do **not** protect `/users`, `/tickets`, etc.
  - `observe` — the gate verifies the `Authorization: Bearer` token and logs a
    non-PII breadcrumb (`present`/`missing`/`invalid`/`expired`) but never rejects.
    Use this to confirm from real Tier2 traffic that a valid token is round-tripped.
  - `enforce` — every non-`/token` Halo resource requires a valid, unexpired token;
    otherwise the Worker returns `401 { "error": "invalid_token" }`. **Only in this
    mode do the OAuth credentials protect the data endpoints.**

  Rollout: deploy `off` → switch to `observe` and confirm the breadcrumbs show
  `token=present` on live presses → then set `enforce`.
- **Admin gate:** `/admin/sync` and `/admin/test-webhook` require `ADMIN_KEY`,
  compared in constant time (length-checked XOR-accumulate) to avoid a timing oracle.
- **Logging (no PII when `DEBUG_LOGS` is off):** all logging goes through one
  chokepoint (`src/log.ts`) — `breadcrumb()` (always on, non-PII: ids, counts,
  status codes, y/n flags) and `debug()` (verbose bodies/emails/hostnames, gated by
  `DEBUG_LOGS`). The always-on routing line reports host presence (`host=y|n`), not
  the hostname (which can embed a username). Handler errors return
  `{ "error": "internal_error", "request_id": "<uuid>" }` with **no** internal
  detail in the body; the `request_id` correlates to a single breadcrumb. Raw
  upstream (Gorelo) error bodies and dead-letter destination strings are never
  logged unless `DEBUG_LOGS` is on.
- **Invocation logs:** `wrangler.toml` keeps `[observability.logs] invocation_logs`
  **enabled** deliberately — Cloudflare captures per-request metadata (method, path,
  status, timing) at the platform level regardless of source-level silence. This is
  a conscious operator decision for a PHI-adjacent service: set `invocation_logs=false`
  and/or lower `head_sampling_rate` if that retention is unacceptable.
- Secrets are CLI-only (`wrangler secret put`) — never in code or `wrangler.toml`.
  The Gorelo key is never logged.

> Not addressed here (require design decisions, tracked separately): request
> **rate limiting** (F7) and **routing/contact-trust** hardening (F5).

To report a vulnerability, and for the security scope and posture, see
[`SECURITY.md`](SECURITY.md).

## Disclaimer & AI-assisted development

- **AI-assisted:** parts of this repository — including some of the security
  remediations above — were written with the help of an AI coding tool. The AI
  **does not claim authorship of or credit for the pre-existing code** it
  modified; that remains the work of the human authors / copyright holder. Its
  contribution is limited to the specific changes in the commits/PRs where it was
  used.
- **Review before you rely on it:** these changes fixed concrete issues we had and
  **work for our deployment**, but AI-generated code is not independently proven
  correct. If you adopt, fork, or deploy this, **review and test it yourself** —
  "works for us" is not a guarantee it is correct or safe for your use case.
- **No warranty / no liability:** provided under the [MIT License](LICENSE),
  **"AS IS", without warranty of any kind** and with no liability for damages
  arising from its use. See [`SECURITY.md`](SECURITY.md) for the full statement.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (workers pool)
```

Coverage: Halo path routing + `haloResource` normalization, OAuth token, the
Gorelo-backed lookups, the deferred `/tickets`→`/actions` flow (report-based
contact/asset resolution, note-text correlation, catch-all fallback, tagging,
report-link extraction, orphan flush), and the string normalizers.

## Gorelo API notes

A snapshot of the live spec is captured at [`docs/gorelo-swagger.v1.json`](docs/gorelo-swagger.v1.json)
(v1, captured 2026-07-08).

- **`POST /v1/tickets` response** — `{ "ticketId": "<uuid>" }`. No human ticket
  number, no GET-ticket / list-tickets endpoint. `extractTicketNumber` reads
  `ticketId`.
- **`agentAssetIds`** — array of agent UUIDs (`PublicDeviceResponse.id`). Only RMM
  **agent** assets are linkable; `/v1/assets/agents` is the only asset read endpoint,
  so custom/manual assets can't be discovered or mapped.
- **`tagIds`** — array of int64 tag ids (used for the "Submitted VIA HDB" tag).
- **`GET /v1/assets/agents`** — a bare array, no pagination; one call fetches the
  whole fleet.
- **`statusId` is required** despite being marked `nullable` in the swagger — a
  create without it returns HTTP 400, so `DEFAULT_STATUS_ID` (default `1` = New) is
  always sent. `contactId` is optional and left null when no client contact matches.
- **`DEFAULT_PRIORITY`** — the spec ships `PublicTicketPriority=[0..4]` as a bare int
  enum with no labels and no list endpoint; read the label off the Gorelo ticket UI.
  `DEFAULT_SOURCE=6` is the API/integration source (confirmed accepted).

Gorelo API base: `https://api.usw.gorelo.io` (US) / `https://api.aue.gorelo.io`
(AU). Spec: `https://api.usw.gorelo.io/swagger/v1/swagger.json`. Auth header:
`X-API-Key`. Keys are scoped — a key lacking a scope returns `403`.

## Configuration note

The `[vars]` in `wrangler.toml` (Gorelo group/type/status/client ids, the
catch-all client, tag ids) are populated for one specific Gorelo tenant. They are
tenant configuration, not secrets — but if you deploy your own instance, re-run
`scripts/gorelo-ids.sh` and replace them (and the `database_id`) with your own.
All actual secrets (`GORELO_API_KEY`, `ADMIN_KEY`, `NOTIFLY_URLS`, the optional
Halo OAuth pair) are set via `wrangler secret put` and are never committed.

## License

Released under the [MIT License](LICENSE).
