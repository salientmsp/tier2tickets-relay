# tier2tickets-relay

A Cloudflare Worker that **impersonates an osTicket helpdesk** so that
**Tier2Tickets / Helpdesk Buttons** can create tickets in **Gorelo** — a PSA that
Tier2 does not natively support.

On each button press the Worker resolves the correct Gorelo **client** (and,
where possible, **contact** + **asset**) from the endpoint's identity, then
creates the ticket via Gorelo's public API. Because Gorelo is also the RMM here,
the machine pressing the button is almost always already a Gorelo agent — so
matching keys off the machine, with email/domain as fallback.

## How it works

```
Helpdesk Buttons ──POST (osTicket shape)──▶  Worker  ──▶ Gorelo POST /v1/tickets
   (Tier2 cloud, 2 fixed IPs)                  │
                                               ├─ parse [[hdb ...]] tag, strip from body
                                               ├─ match client via D1 mirror (hostname→UPN→domain→catch-all)
                                               ├─ resolve contact live (GET /v1/contacts?clientid=)
                                               └─ 201 + ticket number  (or 502 on upstream failure)

Cron (every 6h) / POST /admin/sync / first-press bootstrap ──▶ syncAll() rebuilds the D1 mirror
```

- We mock **osTicket** specifically because it is **create-only** (no webhooks),
  so there's a single inbound path and no bidirectional sync to fake.
- Success is **HTTP 201 with the ticket number as a plain-text body** — that's
  what Tier2's "Integration Test" and every real press expect. Anything else
  turns the test red.
- On a Gorelo create failure the Worker returns **502** (with the upstream
  status) so Tier2 surfaces a failure instead of silently dropping the ticket.

## Project layout

| Path | Purpose |
|---|---|
| `src/index.ts` | `fetch` + `scheduled` handlers, routing, ticket-create flow |
| `src/parse.ts` | osTicket body parsing, `[[hdb ...]]` tag parse/strip, normalization |
| `src/matcher.ts` | client resolution (hostname → UPN → domain → catch-all) |
| `src/gorelo.ts` | Gorelo API client (retry/backoff, defensive parsing) |
| `src/sync.ts` | `syncAll()` — rebuild the D1 mirror off the request path |
| `src/db.ts` | D1 schema + point lookups |
| `src/ticket.ts` | description/triage-note + `CreatePublicTicketCommand` assembly |
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
#   -> set DEFAULT_GROUP_ID, DEFAULT_TYPE_ID, DEFAULT_STATUS_ID, DEFAULT_PRIORITY, DEFAULT_SOURCE, CATCHALL_CLIENT_ID

# 4. Set secrets (never committed)
wrangler secret put GORELO_API_KEY   # X-API-Key for Gorelo (ticket write + asset/contact/client read)
wrangler secret put EXPECTED_KEY     # the key Tier2 sends us in X-API-Key (gates ticket creation)
wrangler secret put ADMIN_KEY        # gates POST /admin/sync

# 5. Deploy
wrangler deploy

# 6. Seed the D1 mirror (or wait for the first cron / first press to bootstrap it)
curl -X POST https://<your-worker-host>/admin/sync -H "X-Admin-Key: <ADMIN_KEY>"
```

For local development, copy `.dev.vars.example` to `.dev.vars` (git-ignored) and
run `wrangler dev`.

## Helpdesk Buttons portal setup

1. **Integration type:** add an **osTicket** ticket-system integration (create-only).
2. **Ticket System API endpoint:** set to your Worker URL (e.g.
   `https://tier2tickets-relay.<subdomain>.workers.dev/`). Any path is accepted;
   the root is fine.
3. **API key:** set to the value you used for `EXPECTED_KEY`. Tier2 sends it as
   the `X-API-Key` header on every POST.
4. **Dispatcher Rule** — append the machine-identity tag to `msg` so the Worker
   can resolve the client. Dispatcher Rules are **sandboxed Python 3** (variables
   are bare names, not `{}` templates), so add this one-line rule:

   ```python
   msg = msg + '\n\n[[hdb host=' + str(hostname) + ' mac=' + str(mac) + ' ip=' + str(ip) + ']]'
   ```

   It yields e.g. `...\n\n[[hdb host=PC-01 mac=AA:BB:CC:DD:EE:FF ip=10.0.0.5]]`.
   The Worker parses this block and then **strips it** from the description so
   the client-facing ticket body stays clean. `mac`/`ip` are recorded as a
   triage note only (Gorelo has no MAC to match on; IP is unreliable under
   DHCP/NAT).

   Confirmed Tier2 osTicket Dispatcher variables: read-only `name`, `email`,
   `hostname`, `mac`, `ip`, `selections`; writable `msg`, `subject`, `append`,
   `priority`, `alert`, `auto_respond`. **No serial/uuid is available from Tier2.**
   See the [Dispatcher Rules docs](https://docs.tier2tickets.com/content/automations/dispatcher/).

5. Press **Integration Test** — it should return `201` with a ticket number.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /` (any non-admin/non-Halo path) | `X-API-Key: <EXPECTED_KEY>` + IP allowlist | Create a ticket (osTicket shape) |
| `POST /auth/token`, `/api/*` | OAuth2 client_credentials + IP allowlist | HaloPSA mock (see below) |
| `POST /admin/sync` | `X-Admin-Key` / `X-API-Key` / `Authorization: Bearer` = `<ADMIN_KEY>` | Rebuild the D1 mirror on demand |
| `GET /health` | none | Liveness check |

## HaloPSA/ITSM mock (in progress — Phase 1: capture)

osTicket is create-only, so Tier2 never does a PSA contact/asset lookup for it. To
unlock those behaviors (recognizing the user, matching company/contact, attaching
assets, bidirectional webhooks) the Worker also mocks **HaloPSA/ITSM**, the most
capable ticket system Tier2 supports. Because Tier2's client is opaque and Halo has
many endpoints, this is built in two phases:

- **Phase 1 (current, `src/halo.ts`):** completes the OAuth2 `POST /auth/token`
  handshake, **logs every request** (method / path / query / body, secrets redacted)
  with a `HALO CAPTURE` prefix, and returns minimal, plausible Halo shapes (empty
  `{ clients|users|assets: [] }` lookups; a synthetic numeric ticket id on
  `POST /api/Tickets`). **No Gorelo writes yet** — this phase exists to capture
  Tier2's exact request sequence safely.
- **Phase 2 (next):** replace the synthetic responses with real Gorelo-backed
  lookups (client/contact/asset) and ticket create, matched to the shapes the
  capture reveals.

**To capture:** set `HALO_CLIENT_ID` / `HALO_CLIENT_SECRET` secrets, configure a
**test** Tier2 HaloPSA integration pointed at the Worker host (Resource Server *and*
Authorization Server both = the Worker; API key `tenant+client_id:client_secret`),
run the Integration Test + one press, then read the `HALO CAPTURE …` lines in the
Workers logs. Paste those back to drive Phase 2. The osTicket path is untouched, so
this can't disturb a working osTicket setup.

## Matching algorithm

Identity is built from the press: `email` (lowercased), `name`, `host` (short
hostname, lowercased — domain stripped), `mac`, `ip`. Client resolution order:

1. **Device by hostname** — `devices.hostname == host` (from agent `displayName`
   then `name`, normalized short-lowercase).
2. **Device by logged-on user** — `devices.upn == email` (agent `lastLoggedOnUserUpn`).
3. **Domain** — `client_domains.domain == email domain`.
4. **Catch-all** — `CATCHALL_CLIENT_ID`, with a triage note (email/host/mac/ip).

A device match carries `clientId`, `clientLocationId → locationId`, and the agent
`id → agentAssetIds: [id]`. `contactId` is resolved **live** via
`GET /v1/contacts?clientid={clientId}` matching `primaryEmail == email`.

## Data store & refresh

Gorelo's agent/client lists have no server-side filters, so they're mirrored into
**D1** for indexed point lookups per press — never pulled on the request path.

- **Cron Trigger** (`crons = ["0 */6 * * *"]`) → `syncAll()` via `ctx.waitUntil`.
- **Manual** `POST /admin/sync` (gated by `ADMIN_KEY`) for post-onboarding refresh.
- **Lazy bootstrap** — on the first press ever (no `last_sync` row), `syncAll()`
  runs once inline so a fresh deploy self-heals.
- `syncAll()` fetches agents + clients, rebuilds both tables (delete + chunked
  batched inserts, ~100 rows/batch), and stamps `last_sync`, with retry/backoff
  on Gorelo `429`/`5xx`.

Contacts stay **live** (small per-client list, keeps requester mapping fresh).

## Security

- **IP allowlist:** when `ENFORCE_IP_ALLOWLIST=true`, only Tier2's two fixed
  source IPs (`34.202.14.153`, `3.209.57.193`, via `CF-Connecting-IP`) may create
  tickets.
- **Key gate:** incoming `X-API-Key` must equal `EXPECTED_KEY`; `/admin/sync`
  requires `ADMIN_KEY`.
- Secrets are CLI-only (`wrangler secret put`) — never in code or `wrangler.toml`.
  The Gorelo key is never logged.

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest (workers pool)
```

Coverage: tag parse + strip, body parsing (JSON + form), matcher (hostname / UPN
/ domain / catch-all + normalization), osTicket→`CreatePublicTicketCommand`
mapping with Gorelo calls mocked, `201` success + id, and `502` on Gorelo
failure.

## Runtime-verify checklist

A snapshot of the live spec is captured at [`docs/gorelo-swagger.v1.json`](docs/gorelo-swagger.v1.json)
(v1, captured 2026-07-08). It resolved most of the original open items:

- ✅ **`agentAssetIds` item type** — confirmed `string` (uuid); `PublicDeviceResponse.id`
  is a uuid. Handled as-is.
- ✅ **`POST /v1/tickets` response shape** — confirmed `CreatePublicTicketResult =
  { "ticketId": "<uuid>" }`. There is **no** human ticket-number field and **no**
  GET-ticket/list-tickets endpoint. `extractTicketNumber` reads `ticketId` first.

### Response we return to Tier2 (osTicket contract)

Tier2's client is built for **real osTicket**, whose successful-create response is
`HTTP 201`, `Content-Type: text/html`, body = the ticket **number** (numeric by
default). We mirror that: `osTicketSuccess()` returns 201 + `text/html`, and
`toOsTicketNumber()` derives a **stable numeric** id from Gorelo's UUID (first 8
hex → a ≤10-digit decimal), because Gorelo exposes no numeric ticket number and
Tier2 parses the body as a number (a UUID/hex string triggers Tier2's
"error reading the response" / "Invalid Response from Ticket System"). The raw
Gorelo UUID is logged on every create for traceability. **Caveat:** the number
Tier2 shows is a derived reference, not Gorelo's own ticket number (the API can't
provide one).
- ✅ **`GET /v1/assets/agents` pagination** — confirmed a bare array, no query
  params / pagination. Single call fetches the whole fleet.
- ✅ **Dispatcher Rule syntax** — confirmed Dispatcher Rules are sandboxed
  Python 3; the tag is built by concatenation, not `{}` interpolation. The rule
  to configure is documented under "Helpdesk Buttons portal setup" above.

Still to confirm against your tenant / portal:

1. **Priority label** (`wrangler.toml`) — the spec ships `PublicTicketPriority=[0..4]`
   as a **bare int enum with no labels** and no list endpoint, so the API can't reveal
   the mapping. Read the label off the priority dropdown in the Gorelo ticket UI and set
   `DEFAULT_PRIORITY` (current `2` is a valid mid default). `DEFAULT_SOURCE` is set to `6`
   (the API/integration source, confirmed accepted).

**Required-fields note (learned from live testing):** despite the swagger marking it
`nullable`, Gorelo's runtime validator **requires `statusId`** — a create without it
returns HTTP 400. `DEFAULT_STATUS_ID` (default `1` = New) is always sent. `contactId` is
**optional** (creates succeed without it), so it's resolved best-effort and left null when
no client contact matches the requester email.

Gorelo API base: `https://api.usw.gorelo.io` (US) / `https://api.aue.gorelo.io`
(AU). Spec: `https://api.usw.gorelo.io/swagger/v1/swagger.json`. Auth header:
`X-API-Key`. Keys are scoped — a key lacking a scope returns `403`.
