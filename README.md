# tier2tickets-relay

A Cloudflare Worker that **impersonates a HaloPSA/ITSM instance** so that
**Tier2Tickets / Helpdesk Buttons** can create tickets in **Gorelo** — a PSA that
Tier2 does not natively support.

On each button press Tier2 runs its Halo integration against the Worker: it
authenticates (OAuth2), looks up the user / company / site / asset, creates the
ticket, then posts the report as a follow-up note. The Worker answers those
lookups from a **D1 mirror of Gorelo** and maps the create back to a real Gorelo
ticket — resolving the correct client, contact and asset, then packing the report,
device details and HDB portal links into the ticket body.

> An earlier version also mocked **osTicket** (create-only). That path has been
> removed — Halo is the sole integration, because it's the only one that lets
> Tier2 do the PSA lookups (contact/company/asset matching) we need.

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

- Tier2 sends every Halo call with a `halo-app-name` header (and unprefixed
  lowercase paths like `/token`, `/users`, `/tickets`), which is how the Worker
  routes them.
- The Worker **always** returns decodable JSON — Tier2's Halo client fails hard on
  any non-JSON body, so every handler is wrapped to emit JSON even on error.
- On a Gorelo create failure the `/actions` call returns **502** (with the upstream
  status) so Tier2 surfaces a failure instead of silently dropping the ticket.

## Project layout

| Path | Purpose |
|---|---|
| `src/index.ts` | `fetch` + `scheduled` handlers, routing (admin/health/Halo) |
| `src/halo.ts` | the HaloPSA mock — token, lookups, deferred create, report parsing |
| `src/gorelo.ts` | Gorelo API client (retry/backoff, defensive parsing) |
| `src/sync.ts` | `syncAll()` — rebuild the D1 mirror off the request path |
| `src/db.ts` | D1 schema + point lookups (+ the deferred-ticket queue) |
| `src/parse.ts` | small string normalizers (`normalizeHost`, `normalizeEmail`) |
| `src/tier2.ts` | Tier2 source-IP allowlist |
| `src/types.ts` | `Env` + hand-written subset of Gorelo API types |
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

# 3. Fill the Gorelo IDs in wrangler.toml [vars]
GORELO_API_KEY=xxxx ./scripts/gorelo-ids.sh
#   -> set DEFAULT_GROUP_ID, DEFAULT_TYPE_ID, DEFAULT_STATUS_ID, DEFAULT_PRIORITY,
#      DEFAULT_SOURCE, CATCHALL_CLIENT_ID, HDB_TAG_ID, EMERGENCY_PRIORITY, DEBUG_LOGS

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
| `POST /token`, `/users`, `/client`, `/site`, `/asset`, `/tickets`, `/actions`, … | OAuth2 client_credentials + IP allowlist (routed by the `halo-app-name` header) | HaloPSA mock (see below) |
| `POST /admin/sync` | `X-Admin-Key` / `X-API-Key` / `Authorization: Bearer` = `<ADMIN_KEY>` | Rebuild the D1 mirror on demand |
| `POST /admin/test-webhook` | `ADMIN_KEY` (same as `/admin/sync`) | Fire a test alert through the dead-letter webhook and report its HTTP status |
| `GET`/`HEAD` `/health` | none | Liveness check (accepts `HEAD` for uptime monitors) |

Anything else returns `404`.

## HaloPSA/ITSM mock (`src/halo.ts`)

| Tier2 call | Worker response |
|---|---|
| `POST /token` (client_credentials) | OAuth2 bearer token (validates `HALO_CLIENT_ID/SECRET` if set) |
| `GET /users?search={email}` | the Gorelo **contact** (id/name/email/client/site); the `unregistered@helpdeskbuttons.com` catch-all maps to `CATCHALL_CLIENT_ID` |
| `GET /client` / `GET /site` | Gorelo **clients** / **locations** from the mirror |
| `GET /asset?search={hostname}` | the Gorelo **agent/device** (numeric surrogate id ↔ agent UUID) |
| `GET /tickettype\|status\|team\|priority\|agent` | minimal default lists (from env) |
| `POST /tickets` | builds the Gorelo command and **queues** it (keyed by the Halo id returned); does NOT create the ticket yet |
| `POST /actions` | folds the report links into the queued command, then **creates** the Gorelo ticket (correlated by explicit `ticket_id`, else the ticket number parsed from the note text) |

**Deferred create:** Tier2 posts the ticket, then posts the report/notification as a
separate `/actions` note. Gorelo has no ticket-append endpoint, so the `/tickets`
call queues the command in `pending_tickets` and the `/actions` call creates the
single Gorelo ticket. A press whose note never arrives is created by an orphan
flush (the `*/5 * * * *` cron, plus an opportunistic sweep off live requests)
after `PENDING_GRACE_MS`. A command that keeps failing to create is **dead-lettered**
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

**Known limitation — the ticket number shown to the user is not the Gorelo ticket
number.** The "ticket number" on the HDB "Help Data Delivered" confirmation screen is
a synthetic id the Worker mints and returns on `POST /tickets` (the `haloId` in
`src/halo.ts` — a surrogate of a random UUID). It is **not** the ticket number Gorelo
assigns. This is unavoidable today: the create is deferred (the real Gorelo ticket
isn't created until the `/actions` note arrives), and even on create Gorelo's `POST
/v1/tickets` returns only `{ "ticketId": "<uuid>" }` — no human-readable ticket number,
and there is no GET-ticket / list-tickets endpoint to read one back. So Tier2 has
nothing real to display and the Worker hands it a placeholder to correlate the note.
Gorelo has indicated an API update exposing the created ticket number is expected
within ~a month; once available, the Worker can return the real number instead of the
surrogate. The Gorelo-side ticket itself is created correctly — only the number echoed
back to the end user is a placeholder. Tracked in
[#35](https://github.com/salientmsp/tier2tickets-relay/issues/35) (fix pending the
Gorelo API update).

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

## Data store & refresh

Gorelo's agent/client lists have no server-side filters, so they're mirrored into
**D1** for indexed point lookups per press — never pulled on the request path.

- **Cron Triggers** (`crons = ["0 */6 * * *", "*/5 * * * *"]`): the 6-hourly cron runs
  `syncAll()`; the frequent cron flushes orphaned deferred tickets. Differentiated
  in `scheduled` by `event.cron`.
- **Manual** `POST /admin/sync` (gated by `ADMIN_KEY`) for post-onboarding refresh.
- **Lazy bootstrap** — on the first Halo call ever (no `last_sync` row), `syncAll()`
  runs once inline so a fresh deploy self-heals.
- `syncAll()` mirrors clients, locations (per-client), contacts (per-client,
  bounded concurrency) and the agent fleet (rich device rows with `asset_num`),
  with retry/backoff on Gorelo `429`/`5xx`. It **delta-reconciles** each table
  rather than rewriting it: every fetched row is upserted with an `ON CONFLICT …
  DO UPDATE … WHERE <columns differ>` guard (so unchanged rows write nothing),
  then only rows that vanished upstream are deleted. D1 writes per sync scale with
  actual churn, not fleet size — a no-change sync costs ~0 writes, which keeps the
  6-hourly refresh cheap even for large tenants. (Devices upsert on a unique
  `agent_id` index; the other tables on their integer primary key.)
- **Observability** — `syncAll()` returns `changed` (rows actually written this
  run) and `deleted` (rows removed as stale) alongside the mirrored totals. Both
  are logged by the cron and echoed in the `POST /admin/sync` response, so a
  steady state reads `changed=0 deleted=0`.
- **Failure alerts** — if a sync throws (cron, `POST /admin/sync`, or the lazy
  bootstrap), it fires the configured notifly webhook(s) (`NOTIFLY_URLS`, the same
  path as dead-letter alerts) so a stale mirror doesn't degrade silently. No-op
  when `NOTIFLY_URLS` is unset.

## Security

- **IP allowlist:** when `ENFORCE_IP_ALLOWLIST=true`, only Tier2's two fixed
  source IPs (`34.202.14.153`, `3.209.57.193`, via `CF-Connecting-IP`) may reach
  the Halo mock.
- **Admin gate:** `/admin/sync` requires `ADMIN_KEY`. The optional Halo OAuth
  credentials (`HALO_CLIENT_ID`/`HALO_CLIENT_SECRET`) are validated at `/token`
  when set.
- Secrets are CLI-only (`wrangler secret put`) — never in code or `wrangler.toml`.
  The Gorelo key is never logged.

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
