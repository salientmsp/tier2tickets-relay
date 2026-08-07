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
| **Tier2Tickets / Helpdesk Buttons** | 2 fixed IPs | `POST /tickets` creates immediately and returns the real ticket number; the `/actions` note is a no-op |
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
   GET  /users /client /site /asset                                 ├─ POST /tickets: resolve routing, CREATE now, return the real number
   POST /tickets                                                    ├─ GET /api/Tickets/{id}: verify (served from the created ledger)
   POST /actions (report note)                                      └─ POST /actions: no-op accept (create fallback if /tickets failed)

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
| `src/index.ts` | `fetch` + `scheduled` handlers, routing (admin/health/alerts/Halo) |
| `src/halo.ts` | the HaloPSA mock — token, lookups, per-product create, report parsing |
| `src/alerts.ts` | monitoring-alert ingress (`POST /v1/alerts`) — auth, dedup by `dedupe_key`, Gorelo mapping |
| `src/products.ts` | product registry (`PRODUCTS`, IPs/CIDRs, `ENABLE_*`, UA gate, per-product OAuth creds, `matchProduct`, `haloCredentials`, `ipAllowed`) |
| `src/haloShapes.ts` | full Halo config-item shapes (status/type/priority/team), field lists derived from the swagger |
| `src/gorelo.ts` | Gorelo API client (retry/backoff, defensive parsing) |
| `src/sync.ts` | `syncAll()` — rebuild the D1 mirror off the request path |
| `src/db.ts` | D1 schema + point lookups (+ the deferred-ticket queue) |
| `src/parse.ts` | small string normalizers (`normalizeHost`, `normalizeEmail`) |
| `src/types.ts` | `Env` + hand-written subset of Gorelo API types |
| `docs/halo-swagger.v2.json` | the real HaloPSA OpenAPI spec — reference for shaping mock responses |
| `migrations/0001_init.sql` | D1 schema (also self-created at runtime) |
| `scripts/gorelo-ids.sh` | dump groups/types/statuses/clients to fill the vars |
| `scripts/halo-cred.sh` / `.ps1` | generate a per-product Halo OAuth pair, push the secret via `wrangler secret put`, print the creds (Bash and PowerShell) |
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
#      DEFAULT_SOURCE, CATCHALL_CLIENT_ID, HDB_TAG_ID, HUNTRESS_TAG_ID, FALLBACK_TAG_ID,
#      EMERGENCY_PRIORITY, DEBUG_LOGS,
#      HALO_TOKEN_ENFORCE (off|observe|enforce — see Security)

# 4. Set secrets (never committed)
wrangler secret put GORELO_API_KEY     # X-API-Key for Gorelo (ticket write + asset/contact/client read)
wrangler secret put ADMIN_KEY          # gates POST /admin/sync
wrangler secret put ALERT_SHARED_SECRET # optional: gates POST /v1/alerts (Bearer / X-Alert-Key)
# Per-product Halo mock OAuth secrets (issue #51) — one client_secret per product,
# paired with its (non-secret) client_id var. Easiest: ./scripts/halo-cred.sh <product>
# (Windows: ./scripts/halo-cred.ps1 <product>)
wrangler secret put HALO_CLIENT_SECRET          # optional: tier2's client_secret (validated with HALO_CLIENT_ID)
wrangler secret put HALO_CLIENT_SECRET_HUNTRESS # optional: Huntress's client_secret (validated with HALO_CLIENT_ID_HUNTRESS)

# 5. Deploy
wrangler deploy

# 6. Seed the D1 mirror (or wait for the first cron / first call to bootstrap it)
curl -X POST https://<your-worker-host>/admin/sync -H "X-Admin-Key: <ADMIN_KEY>"
```

For local development, copy `.dev.vars.example` to `.dev.vars` (git-ignored) and
run `wrangler dev`. See the workflow below.

## Local development

Develop and test **without deploying to prod**. `wrangler dev` runs the Worker on
Miniflare with a **local D1** (a SQLite file under `.wrangler/state`, keyed by the D1
binding — the `database_id` in `wrangler.toml` is only used for `--remote`/`deploy`, so
local state is fully isolated from prod) and local queues/crons. The vitest suite
(`npm test`) likewise runs against an isolated in-memory D1 — neither touches prod.

Outbound calls to **Gorelo are real**: point `GORELO_BASE_URL` / `GORELO_API_KEY` in
`.dev.vars` at whatever tenant you want to exercise. That means a `triggered` alert
against the local Worker posts a **real** Gorelo alert (and a Halo press files a **real**
ticket) — use an obvious `TEST —` title, or exercise no-write paths (an alert
`heartbeat`, or the health endpoints) when you don't want side effects.

### Dev container

`.devcontainer/` pins Node to match CI and installs deps on create — open the repo in a
[dev container](https://containers.dev) (VS Code "Reopen in Container", GitHub Codespaces,
or Claude Code on the web) and you get a ready toolchain with port `8787` published.

### Reaching the local Worker from other devices on the network

To let another device on your LAN (e.g. a test SQL/monitoring host) hit the local
Worker, two things must line up:

1. **wrangler must listen on all interfaces** inside the container, not just
   `localhost`: use `npm run dev:lan` (`wrangler dev --ip 0.0.0.0`).
2. **the port must be published to the host on `0.0.0.0`.** The dev container does this
   via `appPort` (a real Docker `-p 8787:8787` publish) plus VS Code's
   `remote.localPortHost: allInterfaces`. Outside the container, `wrangler dev --ip
   0.0.0.0` already binds the host directly.

Then other devices reach it at **`http://<host-LAN-IP>:8787`** (find `<host-LAN-IP>` with
`ipconfig` / `ip addr`). Also allow inbound `8787` through the host firewall.

- **Codespaces / cloud dev containers** have no LAN — instead set the forwarded port's
  visibility to **public** and share the generated `*.app.github.dev` URL.
- **IP allowlist caveat:** the Halo/alerts IP allowlist keys off Cloudflare's
  `CF-Connecting-IP` header, which is **not present** in local `wrangler dev`. For LAN
  testing either set `ENFORCE_IP_ALLOWLIST="false"` in `.dev.vars` (rely on the shared
  secret / bearer token instead), or have the client send a `CF-Connecting-IP` header
  matching the allowlist.
- **Security:** this exposes a local Worker holding **real Gorelo creds** to your LAN —
  keep it to trusted networks, and remember ticket-creating requests file real tickets.

### First run

```bash
cp .dev.vars.example .dev.vars     # then fill in a real GORELO_API_KEY (+ ADMIN_KEY, etc.)
npm ci                             # (skipped if the dev container already ran it)
npm run dev:setup                  # apply migrations + seed synthetic data into local D1
npm run dev                        # wrangler dev -> http://localhost:8787
```

`dev:setup` runs `db:migrate:local` then `db:seed:local`. The seed
(`scripts/seed-dev.sql`) is **synthetic** — never seed real mirror data (names/emails/
hosts are PHI) into a dev DB. It also stamps `last_sync` so the Worker won't lazily pull
the real Gorelo mirror into your local D1. If you *do* want a real mirror locally, run
`curl -X POST localhost:8787/admin/sync -H "X-Admin-Key: <ADMIN_KEY>"` (pulls real Gorelo
data — PHI — into the local DB).

### Smoke test

```bash
curl -i localhost:8787/health         # 200 ok
```

Local DB helpers: `npm run db:migrate:local`, `npm run db:seed:local`, and
`npm run db:reset:local` (wipes the local D1 and re-seeds).

### npm v12 install scripts (`allowScripts`)

npm v12 blocks dependency install scripts by default. `workerd` (wrangler dev's
runtime) and `esbuild` (the bundler) need theirs, so they're allowlisted in
`package.json` → `allowScripts`, keyed by bare package **name** (like pnpm's
`onlyBuiltDependencies` and bun's `trustedDependencies`). Name keys don't embed a
version, so a Renovate bump to either package never invalidates the allowlist and no
regeneration step is needed.

A **CI guard** (`npm run check:allowscripts`) keeps it honest: it fails the build if
`workerd`/`esbuild` are present in the lockfile but missing from `allowScripts`,
printing the one-line fix (add `"<name>": true` and commit `package.json`).

## Helpdesk Buttons portal setup

Configure Tier2 as a **HaloPSA — Cloud Hosted** integration:

1. **Integration type:** HaloPSA / HaloITSM (Cloud Hosted).
2. **Resource Server *and* Authorization Server:** both = your Worker host
   (e.g. `https://tier2tickets-relay.<subdomain>.workers.dev`).
3. **API key:** the `tenant+client_id:client_secret` credential. Credentials are
   **per product** (issue #51): if you set that product's `client_id`/`client_secret`
   pair (tier2 → `HALO_CLIENT_ID`/`HALO_CLIENT_SECRET`), the token endpoint validates
   them; otherwise any credentials are accepted. (The on-prem `client_id:client_secret`
   form is tolerated too.) Generate a pair and push the secret with
   `./scripts/halo-cred.sh tier2` (Windows: `./scripts/halo-cred.ps1 tier2`), then
   paste the printed `client_id`/`client_secret` here.
4. Press **Integration Test** / do a real press — the Worker answers the OAuth +
   lookup + create + note sequence, and a Gorelo ticket appears.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `/token`, `/users`, `/client`, `/site`, `/asset`, `/tickets`, `/actions`, … (and `/api/*` forms) | product allowlist (enforced by default) + optional bearer-token gate — see [Security](#security); recognized by the `halo-app-name` header or the path shape | HaloPSA mock (see below) |
| `POST /admin/sync` | `X-Admin-Key` / `X-API-Key` / `Authorization: Bearer` = `<ADMIN_KEY>` | Refresh the D1 mirror on demand (fans location fetches out to the queue) |
| `GET /admin/status` | `ADMIN_KEY` (same as `/admin/sync`) | Pretty JSON: mirror row counts, `lastSync`, and `locationQueue` (`queued` / `drained` / `lagSeconds`) — follow the location fan-out |
| `POST /admin/test-webhook` | `ADMIN_KEY` (same as `/admin/sync`) | Fire a test alert through the dead-letter webhook and report its HTTP status |
| `POST /v1/alerts` | **per-source** two-factor: the source's own secret (`Authorization: Bearer` / `X-Alert-Key`) **bound to** that source's own IP allowlist (see [Monitoring alerts](#monitoring-alerts)) | Monitoring-alert ingress — create/update/resolve a Gorelo alert, deduplicated by `dedupe_key` |
| `GET`/`HEAD` `/v1/alerts/health` | none | Alert-proxy liveness descriptor (`{"status":"ok","service":"Gorelo alert proxy"}`) — no secrets |
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
| `POST /token` (client_credentials) | validates the **matched product's** `client_id`/`client_secret` (if set — tier2 via `HALO_CLIENT_ID/SECRET`, Huntress via `HALO_CLIENT_ID_HUNTRESS/SECRET`) and returns a bearer token — a signed HMAC token bound to that product when creds are set, else an opaque one. Enforcement on the endpoints below is governed by `HALO_TOKEN_ENFORCE` (see [Security](#security)) |
| `GET /users?search={email}` | the Gorelo **contact** (id/name/email/client/site) in the `Users_View` envelope; the `unregistered@helpdeskbuttons.com` catch-all maps to `CATCHALL_CLIENT_ID` |
| `GET /client` / `GET /site` | Gorelo **clients** / **locations** from the mirror (`Area_View` / `Site_View` envelope) |
| `GET /client/{id}` | a **single** Halo `Area` object (not the list envelope) — name from the mirror, synthesized for an unmirrored id (e.g. the catch-all) |
| `GET /asset?search={hostname}` | the Gorelo **agent/device** (numeric surrogate id ↔ agent UUID) in the `Device_View` envelope |
| `GET /tickettype\|status\|team\|priority` | **full-shape** bare arrays (`src/haloShapes.ts`); `status` returns an open→closed set so a PSA editor's closed-status mapping resolves |
| `POST /tickets` (or `/api/Tickets`) | build the Gorelo command and **create it immediately**, returning the real Gorelo ticket number as the id. Accepts a single object or a Halo-style array |
| `GET /api/Tickets/{id}` | the client's post-create **verify** step (Huntress): served from the `created_tickets` ledger — 200 with the ticket + real number, or 404 |
| `POST /actions` | a no-op accept for the Tier2 two-step (the create already happened on `/tickets`); still creates as a fallback if an earlier create failed and queued the command |

**Immediate create (both products, `deferCreate: false`).** The full report is already
in the `/tickets` body, so we create the Gorelo ticket on `/tickets`, read its real
number back (`GET /v1/tickets`), and hand **that number** back as the ticket id. This
matters because:

- The client shows the **real** Gorelo number, not a synthetic surrogate.
- **Huntress** then calls `GET /api/Tickets/{id}` to verify creation; we answer it from
  the `created_tickets` ledger, so it stops treating the create as failed and retrying
  (a duplicate source).

If the create call fails, we fall back to the `pending_tickets` queue so the orphan
flush (the `*/5 * * * *` cron, plus a small opportunistic sweep off live requests)
retries it after `PENDING_GRACE_MS` — and for Tier2 the follow-up `/actions` note also
creates it as a fallback. The flush claims one orphan at a time and bounds how many it
processes per run, so the request's `waitUntil` task can't overrun its budget and drop
a pre-claimed batch; a failed create is re-queued with a fresh timestamp and retried a
grace window later. Submitter name and body heading are product-aware (Huntress →
`"Huntress"` / `"Details"` vs the HDB `"Helpdesk Buttons"` / `"Report Summary"`).

**Huntress resolutions.** Huntress signals an incident resolution by **editing the
original ticket** (a `POST /Tickets` carrying its `id`) to its configured *"Status after
Huntress Resolution"*. Gorelo has **no ticket-update endpoint** (`POST`/`GET` only — no
`PUT`/`PATCH`, no `/v1/tickets/{id}`), so the relay can't mutate the original Gorelo
ticket. Instead, when an incoming `POST /tickets` carries an `id` that matches a row in
the `created_tickets` ledger (a ticket **we** issued — a brand-new alert never does, so a
real alert can't be misread as a resolution), the relay files a **clearly-labeled
resolution notice** in Gorelo — a `Resolved: …` ticket that names the original and lands
in `DEFAULT_RESOLVED_STATUS_ID` (falls back to `DEFAULT_STATUS_ID` when unset) — marks the
original resolved in the ledger, and echoes the original id back as resolved. The original
Gorelo ticket must still be **closed manually** (the notice says so), since the API can't.

> **Note — Tier2 was previously a deferred two-step** (`/tickets` queued, `/actions`
> folded the HDB "View Report" link in before creating). It's now eager so the
> confirmation screen can show the real number; the trade is that the "View Report"
> link the `/actions` note carried can't be added post-create (Gorelo has no
> ticket-append endpoint), so it's dropped. The report summary itself is in the
> `/tickets` body, so tickets keep their content.

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

**The real Gorelo ticket number is resolved and handed back as the ticket id.**
Gorelo's `POST /v1/tickets` returns only the ticket GUID (`{ "id": "<uuid>" }`), but
the `GET /v1/tickets` list (added 2026-07) carries the human `number` / `displayNumber`.
Because both products now create on `POST /tickets` (see above), the relay reads the
number back by matching that GUID (`GoreloClient.resolveTicketNumber`) and returns it
as the **ticket id** in the create response — so Tier2's "Help Data Delivered" screen
and Huntress both show the real number instead of a synthetic surrogate. The
`gorelo_ticket_number` / `gorelo_display_number` fields carry it explicitly too, and
`GET /api/Tickets/{id}` (served from the `created_tickets` ledger) returns it on a
verify. The read-back is best-effort — if it fails, we fall back to the synthetic
surrogate id and the ledger row still records the create. Tracked in
[#35](https://github.com/salientmsp/tier2tickets-relay/issues/35).

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

**Tagging:** every ticket gets a "Submitted via …" Gorelo tag (via `tagIds`) naming the
source that submitted it, for filtering/reporting. Each product carries its own tag —
Helpdesk Buttons/Tier2 → `HDB_TAG_ID` (31974 "Submitted VIA HDB"), Huntress →
`HUNTRESS_TAG_ID` (32870 "Submitted via Huntress"). A ticket whose product has no tag of
its own — a new service onboarded before its dedicated tag is wired up, or a request that
matched no product — falls back to `FALLBACK_TAG_ID` (32885 "Submitted via API") so
nothing is left untagged. These are tags, not the ticket type (`DEFAULT_TYPE_ID` stays
7045 "Incident"). To add a per-service tag: set the product's `tagVar` in
`src/products.ts` and its `*_TAG_ID` var in `wrangler.toml`.

**Attachments (screenshots / diagnostic data):** the binaries are **not** sent to us.
HDB hosts the full report and the remote session on its own portal and only sends
hyperlinks, which we surface in the ticket. Gorelo's public API has no attachment
endpoint, so linking is the only way to reach that content from a ticket.

**Logging:** by default only non-PII breadcrumbs are logged (method/path/status +
resolved ids in the `HALO routing:` line). Set `DEBUG_LOGS=true` to log full
`HALO CAPTURE` / `HALO RESPONSE` bodies (which contain PII/PHI — names, emails,
phones) for a short debugging window, then turn it back off.

## Monitoring alerts

`POST /v1/alerts` (`src/alerts.ts`) is a standardized HTTPS ingress for monitoring
sources — an on-prem Windows/SQL Server, a scheduled job, any script — to raise,
update, and resolve alerts in Gorelo through this IP-allowlisted proxy. It is
**independent of the HaloPSA mock**: its own per-source credentials, its own JSON
contract. It is deliberately generic — **the sender owns all identifiers** (`source`,
`host`, `customer`, `monitor_id`, `dedupe_key`, `title`, `details`, …); the Worker
validates and routes but never hard-codes any monitor, host, or customer. The values
shown below are illustrative placeholders, not an enforced list.

### Authentication — per-source secret bound to IP

Like each Halo product, an alert **source** (a customer) is two-factor: it has its own
shared secret **bound to** its own IP allowlist. A request must both present the
source's secret (`Authorization: Bearer <secret>`, preferred, or `X-Alert-Key: <secret>`)
**and** originate from an IP in that source's list. So:

- wrong/unknown secret → **`401`** (regardless of IP)
- a valid secret presented from an IP outside *its* source's list → **`403`**

One customer's secret is therefore useless from another customer's network. The
presented secret **identifies** the source (matched constant-time across all sources),
then that source's IP allowlist is enforced.

Sources are env-configured, so onboarding a customer needs **no code change**:
`ALERT_SOURCES` is a comma/space-separated list of source keys (unset ⇒ just the
built-in `default`). Per key the credential pair resolves by name:

| Source key | Secret var | IP-allowlist var |
|---|---|---|
| `default` | `ALERT_SHARED_SECRET` | `ALERT_ALLOWED_IPS` |
| `<key>` (e.g. `acme`) | `ALERT_SECRET_<KEY>` (e.g. `ALERT_SECRET_ACME`) | `ALERT_IPS_<KEY>` (e.g. `ALERT_IPS_ACME`) |

(`<KEY>` = the key upper-cased with non-alphanumerics → `_`.) A source whose secret is
unset is skipped, so it can never authenticate. IP enforcement follows the shared
`ENFORCE_IP_ALLOWLIST` flag. To add customer `acme`: append `acme` to `ALERT_SOURCES`,
set `ALERT_IPS_ACME` in `[vars]`, and `wrangler secret put ALERT_SECRET_ACME`.

Each source's IP-allowlist var holds a **list** — any mix of exact IPs and IPv4 CIDR
ranges/subnets, comma/space/newline separated (same format and `ipInCidr` matcher as
the product allowlists), e.g. `ALERT_IPS_ACME = "203.0.113.7, 198.51.100.0/24, 192.0.2.0/28"`.

### Request

`Content-Type: application/json`. Required fields: `source`, `host`, `monitor_id`,
`dedupe_key`, `status`, `severity`, `title`, `message`, `timestamp`. Optional:
`customer`, `event_id`, `details` (an arbitrary object, rendered into the ticket).

```jsonc
{
  "source": "SQL Backup Monitor",
  "host": "DB-SERVER-01",
  "customer": "Example Customer",
  "monitor_id": "daily-restore",
  "event_id": "2026-08-05-daily-restore",
  "dedupe_key": "DB-SERVER-01:daily-restore",
  "status": "triggered",              // triggered | resolved | heartbeat
  "severity": "critical",             // info | warning | critical
  "title": "Daily restore failed",
  "message": "The daily transaction-log restore failed after all retry attempts.",
  "timestamp": "2026-08-05T01:30:00-05:00",
  "details": { "database": "app_db", "error": "No new transaction-log backup was available." }
}
```

`monitor_id` is an opaque, sender-defined string — the Worker accepts any value and
never validates it against a list. A SQL-server monitor might send e.g.
`daily-restore`, `restore-stale`, `database-state`, `sql-service`, `disk-space-e`,
`etl-failure`, or `heartbeat`, but any naming scheme works.

### Behavior (deduplication)

`dedupe_key` is the stable identity for an alert; the Worker tracks its lifecycle in
the `alerts` D1 table so a retrying monitor never re-raises the same alert.

| `status` | Existing state | Action | Gorelo effect |
|---|---|---|---|
| `triggered` | none / previously resolved | `created` | posts **one** Gorelo alert (`POST /v1/alerts/`) |
| `triggered` | open, new event | `updated` | updates the stored alert — **no** re-post |
| `triggered` | open, same `Idempotency-Key`/`event_id` | `duplicate-ignored` | nothing |
| `resolved` | open | `resolved` | posts a `Resolved: …` Gorelo alert, marks the stored alert resolved |
| `resolved` | none / already resolved | `duplicate-ignored` | nothing (success, no post) |
| `heartbeat` | — | `heartbeat-recorded` | stamps `last_seen` in `alert_heartbeats`, **no** post |

### Response

`202 Accepted` (a `200` is equally valid — Gorelo confirms synchronously here):

```json
{ "accepted": true, "action": "created", "dedupe_key": "DB-SERVER-01:daily-restore" }
```

`action` ∈ `created | updated | resolved | heartbeat-recorded | duplicate-ignored`.
(No `remote_id`: Gorelo's alert endpoint returns a boolean success with no alert id — see
the mapping below.) Errors return `{ "accepted": false, "error": "…" }` with: `400`
invalid JSON / missing or bad field · `401` invalid shared secret · `403` source IP not
allowed · `405` method other than `POST` · `502` Gorelo rejected/unavailable · `500`
unexpected. (`429` is reserved in the contract for rate limiting; the Worker does not
currently throttle.)

### Retry & idempotency

The monitoring script should retry on `429/500/502/503/504`. Retries are safe:
`dedupe_key` collapses repeats to `updated`/`duplicate-ignored`, and an optional
`Idempotency-Key: <unique-event-id>` header (falling back to `event_id`) makes an exact
replay of the **same** event a no-op `duplicate-ignored` rather than an update. A `502`
leaves the alert **unstored/open**, so a retry re-attempts the Gorelo write cleanly.

### Gorelo mapping

Events map to Gorelo's **native alert** endpoint — `POST /v1/alerts/` (`PostAlertRequest`,
*"Posts an external alert against a client"*) — **not** a service ticket:

| Alert field | Gorelo alert field (`PostAlertRequest`) |
|---|---|
| `title` | `Name` |
| `host` | `Resource` (the host/service the alert is raised for) |
| `severity` | `Severity` (`AlertLevel` int) — **fixed** mapping (Gorelo's level enum is not tenant-customizable): `critical`→1 (Critical), `warning`→3 (Warning), `info`→4 (Info/Low). 1 = Critical is confirmed against the Gorelo alerts UI. |
| `message` + `details` + metadata (monitor/source/customer/timestamp/`dedupe_key`) | `Description` (plain text) |
| `customer` / `host` | `ClientId` — `ALERT_CLIENT_ID`, else `customer` matched by exact name against the client mirror, else a mirrored device matched by `host`, else `CATCHALL_CLIENT_ID` |

**Does Gorelo resolve/dedupe by a stored remote id or key?** No. Gorelo **does** have a
native alert endpoint (`POST /v1/alerts/`), but it is **create-only** — the response is a
boolean success envelope with **no alert id**, and there is no update/close/GET for
alerts. So Gorelo offers no server-side dedup key and no way to clear an alert by id.
Deduplication and the open→resolved lifecycle are therefore owned by **this Worker**: the
`dedupe_key` state lives in D1; a repeat `triggered` updates that row without re-posting;
and a `resolved` event posts a fresh `Resolved: …` alert to signal the clear (there is
nothing to send back to Gorelo to close the original).

### Configuration

Per-source credentials (see [Authentication](#authentication--per-source-secret-bound-to-ip)):
`ALERT_SOURCES`, and per key the `ALERT_ALLOWED_IPS`/`ALERT_SHARED_SECRET` (default) or
`ALERT_IPS_<KEY>`/`ALERT_SECRET_<KEY>` pair. Other non-secret vars (`[vars]`): optional
routing overrides `ALERT_CLIENT_ID`, `ALERT_TAG_ID`, `ALERT_PRIORITY_CRITICAL|WARNING|INFO`.
Secrets:

```bash
wrangler secret put ALERT_SHARED_SECRET   # default source (Bearer / X-Alert-Key value)
wrangler secret put ALERT_SECRET_ACME     # per-customer source secret (one per ALERT_SOURCES key)
```

Logged per alert (never the secret): event `timestamp`, source IP, authenticated source
key, `host`, `monitor_id`, `dedupe_key`, `status`, `severity`, action, Gorelo status, and
remote id.

### Examples

Raise (trigger) an alert:

```bash
curl -sS -X POST https://<worker-host>/v1/alerts \
  -H "Authorization: Bearer $ALERT_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 2026-08-05-daily-restore" \
  -d '{
    "source": "SQL Backup Monitor",
    "host": "DB-SERVER-01",
    "customer": "Example Customer",
    "monitor_id": "daily-restore",
    "dedupe_key": "DB-SERVER-01:daily-restore",
    "status": "triggered",
    "severity": "critical",
    "title": "Daily restore failed",
    "message": "The daily transaction-log restore failed after all retry attempts.",
    "timestamp": "2026-08-05T01:30:00-05:00",
    "details": { "database": "app_db", "database_state": "ONLINE" }
  }'
```

Resolve it (same `dedupe_key`):

```bash
curl -sS -X POST https://<worker-host>/v1/alerts \
  -H "X-Alert-Key: $ALERT_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "SQL Backup Monitor",
    "host": "DB-SERVER-01",
    "monitor_id": "daily-restore",
    "dedupe_key": "DB-SERVER-01:daily-restore",
    "status": "resolved",
    "severity": "info",
    "title": "Daily restore recovered",
    "message": "A transaction-log restore succeeded; the alert is cleared.",
    "timestamp": "2026-08-05T02:05:00-05:00"
  }'
```

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
  clientIdVar?: keyof Env;      // Env var holding this product's OAuth client_id
  clientSecretVar?: keyof Env;  // Env secret holding this product's client_secret
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

**Per-product Halo OAuth credentials (issue #51):** each product authenticates with
its **own** `client_id`/`client_secret`, resolved from the `clientIdVar`/`clientSecretVar`
on its `PRODUCTS` entry — tier2 keeps the original `HALO_CLIENT_ID`/`HALO_CLIENT_SECRET`
pair, Huntress uses `HALO_CLIENT_ID_HUNTRESS`/`HALO_CLIENT_SECRET_HUNTRESS`. `/token`
validates the presented creds against the matched product's pair and mints a token
**bound to that product** (a `prod` claim, keyed by that product's secret); the
enforcement gate verifies against the same pair. So `HALO_TOKEN_ENFORCE="enforce"` now
works with **multiple products at once** — each passes with its own token, and one
product's token can't authorize another's request. A product whose pair is **unset**
stays lenient (any creds accepted, no enforcement), so products can be onboarded /
rolled out independently. Generate a pair and push its secret with
`./scripts/halo-cred.sh <product>` (or `./scripts/halo-cred.ps1 <product>` on Windows).

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
- **OAuth credentials → token enforcement (per product, issue #51):** credentials
  are resolved for the request's **matched product** — tier2 via `HALO_CLIENT_ID`/
  `HALO_CLIENT_SECRET`, Huntress via `HALO_CLIENT_ID_HUNTRESS`/`HALO_CLIENT_SECRET_HUNTRESS`
  (when no product matches — e.g. the allowlist is off — the un-suffixed pair is the
  global fallback). Setting a product's pair makes `/token` validate its
  `client_id`/`client_secret` **and** mint a signed HMAC-SHA256 bearer token
  (`payload.sig`, keyed by **that product's** secret, with `exp` and a `prod` claim
  binding it to the product; Web Crypto, no new dependency). Because each product has
  its own pair and its token carries its `prod` claim, **multiple products can all
  pass `enforce` at once** — one product's token never authorizes another's request,
  and the old single-credential limitation (only one product could authenticate under
  `enforce`) is gone. Whether that token then **protects the resource endpoints**
  depends on `HALO_TOKEN_ENFORCE` (the gate is a no-op for a product whose credentials
  are unset — that product stays lenient — and never applies to `/token`):
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

A snapshot of the live spec is captured at [`docs/gorelo-swagger.v1.json`](docs/gorelo-swagger.v1.json).
See [`docs/gorelo-swagger.md`](docs/gorelo-swagger.md) for the source URL and how the
snapshot is kept fresh. Both upstream specs — Gorelo **and** the HaloPSA spec
([`docs/halo-swagger.v2.json`](docs/halo-swagger.v2.json), see
[`docs/halo-swagger.md`](docs/halo-swagger.md)) — are synced by the shared
`scripts/sync-swagger.py` helper, and a nightly
[drift workflow](.github/workflows/swagger-drift.yml) opens a PR for either when its
live spec changes.

- **Standard response envelope (2026-08 breaking change).** Every response is now
  wrapped in `{ StatusCode, IsSuccess, Data, DataContext, Notifications }` with
  **PascalCase** fields; the payload lives in `Data`. Cursor-paging metadata moved
  from the top level into `DataContext.Pagination` (`NextCursor` / `PreviousCursor` /
  `HasMore` / `HasPrevious` / `TotalCount`), and **cursors are signed** (a cursor held
  across the release is rejected once — restart from the first page). Every failure
  carries a **6-digit `Code`** (MMTTNN) in `Notifications[]` — branch/alert on that,
  not on message text. The relay handles all of this at one seam in `src/gorelo.ts`:
  it camelizes responses and unwraps the envelope on the way in, pascalizes the create
  body on the way out, and surfaces the code via `GoreloError.code`. The rest of the
  codebase keeps its camelCase model (`src/types.ts`).
- **`POST /v1/tickets` response** — `Data` is `{ "Id": "<uuid>" }` (the ticket's GUID,
  not a human number). After the client peels the envelope, `extractTicketNumber` reads
  `id`. Request fields must be PascalCase and **unknown/misspelled fields are rejected
  with a 400** — the relay only ever sends the documented `CreatePublicTicketCommand`
  fields.
- **`GET /v1/tickets`** — cursor-paged list. `pageSize` outside **1–200** is now a
  400 (was silently clamped), and `sortBy` (`updatedOn` | `createdOn`) / `sortOrder`
  (`asc` | `desc`) outside those documented values are rejected (was a silent fallback
  to `updatedOn` / `desc`). `Data` items carry the human-readable `Number` /
  `DisplayNumber`, so the real ticket number is read back after a create by matching
  the created `id`.
- **`agentAssetIds`** — array of agent UUIDs (`PublicDeviceResponse.Id`). Only RMM
  **agent** assets are linkable; `/v1/assets/agents` is the only asset read endpoint,
  so custom/manual assets can't be discovered or mapped.
- **`tagIds`** — array of int64 tag ids (used for the "Submitted VIA HDB" tag).
- **`GET /v1/assets/agents`** — cursor-paged (since 2026-07); `getAllPages` follows
  `DataContext.Pagination.NextCursor` to fetch the whole fleet.
- **`statusId` is required** (now **also** enforced at the schema level for
  `POST /ticket/public`) — a create without it returns HTTP 400, so `DEFAULT_STATUS_ID`
  (default `1` = New) is always sent. `contactId` is optional and left null when no
  client contact matches.
- **`DEFAULT_RESOLVED_STATUS_ID`** (optional) — the status a Huntress **resolution
  notice** lands in (see "Huntress resolutions" above); set it to your Gorelo
  "Resolved"/"Closed" status id (`GET /v1/tickets/statuses`). Unset → falls back to
  `DEFAULT_STATUS_ID`.
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
