# Refactor notes — ingress/egress split + Jira egress rework

Two pieces of work, done in order on two branches off `main`:

- **Part A** — `refactor/ingress-egress` (PR #85): restructure the single Worker into
  `core` / `ingress` / `egress` with an internal event spine. No behavior changes.
- **Part B** — `refactor/jira-egress`: rework the PR #77 Jira fan-out to sit on that
  structure as an event subscriber. Branched off `refactor/ingress-egress` (the refactor
  is unmerged), so its diff/PR is against `refactor/ingress-egress`, not `main`.

> **Branch naming:** the automation designated a `claude/…` branch, but the task
> explicitly named `refactor/ingress-egress` and `refactor/jira-egress`, so those were
> used (explicit user instruction wins).

The single rule the whole layout serves: **`ingress/` and `egress/` never import each
other.** Both may import `core/`; `index.ts` may import all three. Enforced by
`scripts/check-import-boundaries.mjs` (CI + `npm run lint:boundaries`).

> **Rebased onto the advanced `main` (post-hoc).** After the initial push, `main` turned
> out to have moved ~20 commits ahead of where this work forked — it had gained a
> **monitoring-alert relay** (`POST /v1/alerts`) and **Sentry** instrumentation across the
> very files this refactor moved. Per your call, both branches were merged onto the new
> `main`:
> - `src/alerts.ts` → **`src/ingress/alerts.ts`** (it's an inbound path), imports rewired.
> - `index.ts` now carries main's Sentry `withSentry` wrap + alert routing **and** the
>   egress Jira wiring together.
> - `core/db.ts` schema is now **v5**, combining the Jira retry queue + the alert/heartbeat
>   tables; `0001_init.sql` carries `created_tickets` + `alerts` + `alert_heartbeats`.
> - `core/types.ts` / `wrangler.toml` / `.dev.vars.example` / `README` carry both feature sets.
>
> Everything below still holds; the only counts that changed are the test totals — the
> full suite is now **167** on the refactor branch (Part A + main's alert/index/gorelo/sync
> specs) and **184** on the Jira branch (adds the 17 Jira specs). The ingress↔egress
> boundary, the event contract, and the egress design are unchanged by the merge.

---

## What changed, per phase

### A1 — pure moves
Moved files into `src/core/` (gorelo, db, log, token, parse, types), `src/ingress/`
(halo, products, haloShapes, sync), `src/egress/` (empty), with `src/index.ts` at root.
Only import paths changed — no logic. `wrangler.toml main` and `tsconfig` still resolve.
All pre-existing tests pass unchanged (only test import paths edited).

### A2 — the event spine (`src/core/events.ts`)
`TicketCreatedEvent` / `TicketResolvedEvent` + a `TicketEventSubscriber` registry
(`registerSubscriber` / `clearSubscribers` / `subscriberCount`) and
`emitTicketCreated` / `emitTicketResolved`. Emitted at the eager-create seam and in
`handleResolution` in `ingress/halo.ts`. Emission is wrapped per-subscriber in
try/catch (a sink can never fail the ticket path) and is a strict no-op with no
subscribers — behavior identical. `test/events.test.ts` asserts both events fire with
the right payloads, the read-back-miss case, unknown-id-is-not-a-resolution, and the
no-subscriber no-op.

### A3 — boundary enforcement
`scripts/check-import-boundaries.mjs` (zero-dependency Node) resolves every relative
import under `ingress/` and `egress/` and fails on any crossing (either direction, any
depth). Wired into `ci.yml` (fast-fail, before install) and `npm run lint:boundaries`.
Proven by injecting a probe import in each direction (fails), then removing it (passes).
Chose a script over ESLint to keep the toolchain minimal — the repo has no ESLint.

### A4 — per-product mapper seam (`src/ingress/mappers/`)
The Helpdesk-Buttons-specific report parsing + description building moved behind a
`ProductMapper` interface (`parse(t) → ParsedInbound`, `buildDescription(...)`). The HDB
report-table logic + the catch-all-user constants live in
`mappers/helpdeskButtons.ts`; the shared product-agnostic render/parse helpers moved to
`ingress/html.ts`. `products.ts` gained a `mapper` field on the `Product` struct.
`halo.ts` now delegates to `product.mapper` (defaulting to the HDB mapper for an
unmatched request — the historical behavior). Behavior unchanged; `test/mappers.test.ts`
adds golden fixtures per shape.

### B2 — `jira.ts` → `src/egress/jira/`
Split into `client.ts` (the dependency-free Jira Cloud client + `JIRA_TARGETS` parsing)
and `subscriber.ts`. Imports only from `core/`.
**Coupling check (B2):** the Jira *client* never reached into Halo-side state — it only
ever took `Env` + a `JiraTarget`. The coupling that existed was the fan-out *wiring*,
which lived inside `halo.ts` (`maybeFanOutJiraCreate/Close`, `flushPendingJira`,
`buildJiraIssueInput` referencing the Halo create/resolution path). That wiring is what
B3 removes — nothing in the client had to be un-coupled, so no fix was needed there.

### B3 — fan-out as an event subscriber
`jiraSubscriber` implements `onTicketCreated` / `onTicketResolved` against the generic
events. It has no knowledge of Halo/Huntress — only that a ticket event occurred for a
Gorelo client, carrying a product key. Enrollment is per client (`JIRA_TARGETS`); labels
use the event's `productKey` (not a hardcoded `"huntress"`). The linked Jira issue key is
**not** on the resolved event (no sink-specific field leaks into the contract) — the
subscriber looks it up from the `created_tickets` ledger by the event's `haloId`.

### B4 — durability kept as-is
`pending_jira` queue, the `*/5` cron flush (`flushPendingJira` in `index.ts`), the
ledger-key create dedup, and the notifly dead-letter after `MAX_JIRA_ATTEMPTS` are
carried over unchanged. `ENABLE_JIRA` stays default-off.

### B5 — migrations
- `migrations/0002_jira_fanout.sql` mirrors what the runtime `initSchema` (schema v4)
  creates: `created_tickets` in its full shape (with `jira_issue_key`) + the
  `pending_jira` table/index. **Confirmed matching** the `CREATE`s in `core/db.ts`.
- `0001_init.sql` was stale — **missing `created_tickets`** (added, in its pre-Jira base
  shape). The `attempts` column the task also flagged is **already present** on
  `pending_tickets` in the current `0001`, so no change was needed there. Fixed in its
  own commit for independent review.

### B6 — docs
README gained a "Jira output (egress)" section: how it works, the two config settings,
step-by-step testing against a **free Jira Cloud site** with an API token from
`id.atlassian.com`, and a table of the three REST calls that are mock-only and need live
verification. `.dev.vars.example` + `wrangler.toml` gained `JIRA_TARGETS` / `ENABLE_JIRA`.
The "Project layout" table was rewritten for the core/ingress/egress structure.

### B7 — tests
- `test/jira.test.ts` — pure unit specs (`jiraEnabled`, `parseJiraTargets`, `adfDoc`,
  `buildJiraIssueInput` with product-key labelling).
- `test/egress-jira.test.ts` — integration against a **mocked** Jira client: subscriber
  wiring on create (issue created + ledger key stored), enrollment gates (off /
  unenrolled → no-op), resolution → close (comment + transition), the `pending_jira`
  drain, the dedup guard, and the dead-letter path. The file header flags loudly that
  every Jira request is stubbed.

Full suite: **148 tests pass**; typecheck + boundary check clean.

---

## Final event contract (`src/core/events.ts`)

### `TicketCreatedEvent` — emitted at the eager-create seam, after the Gorelo create + ledger write

| Field | Type | Availability |
|---|---|---|
| `type` | `"ticket.created"` | always (discriminant) |
| `goreloId` | `string` | always on a successful create; `""` only if the create response carried no id (best-effort) |
| `haloId` | `number` | **always** — the `created_tickets` ledger key (real Gorelo number when the read-back resolved one, else a synthetic surrogate) |
| `number` | `number \| null` | **optional** — best-effort read-back; null when it failed/lagged |
| `displayNumber` | `string \| null` | **optional** — same read-back |
| `productKey` | `string \| null` | null when no product matched (e.g. allowlist disabled) |
| `clientId` | `number` | **always** — routing falls back to the catch-all client, never null |
| `locationId` | `number \| null` | **optional** — null when none resolved |
| `contactId` | `number \| null` | **optional** — null when no contact matched |
| `deviceAssetIds` | `readonly string[]` | may be empty; never null |
| `subject` | `string` | always (the Gorelo command title) |
| `descriptionText` | `string` | always present; may be `""`. The ticket body flattened to neutral plain text (`htmlToText(description)`). **Added in Part B** — a generic field the first sink needs (see decisions). |
| `timestamp` | `string` | ISO-8601 |

### `TicketResolvedEvent` — emitted in `handleResolution`

| Field | Type | Availability |
|---|---|---|
| `type` | `"ticket.resolved"` | always (discriminant) |
| `original.haloId` | `number` | **always** — ledger key of the original ticket (look up sink-specific link data by this) |
| `original.goreloId` | `string \| null` | optional (from the ledger row) |
| `original.number` / `displayNumber` | `number \| null` / `string \| null` | optional |
| `original.title` | `string \| null` | optional |
| `original.clientId` | `number \| null` | optional — used for target/enrollment resolution |
| `original.contactId` | `number \| null` | optional |
| `productKey` | `string \| null` | **optional** — the emitting request's matched product (a resolution is matched by ledger id, so only known when the request matched a product; it normally does) |
| `resolvedStatusId` | `number` | the Gorelo status the resolution moved the ticket into |
| `timestamp` | `string` | ISO-8601 |

No Jira-specific (or any sink-specific) field appears on either event.

---

## Decisions made without you

1. **Branch names** — used `refactor/ingress-egress` and `refactor/jira-egress` as you
   named them, over the automation's designated `claude/…` branch.
2. **Events emit only at the eager-create seam + `handleResolution`**, not at the
   deferred `/actions` create or the orphan-flush create. This matches PR #77's fan-out
   seams exactly (both products are eager; those other paths are failure-recovery), keeps
   the subscriber's `ctx` available for backgrounding, and avoids any double-emit. A Tier2
   ticket created via the *deferred/flush fallback* (only when no product matched) does
   not emit — same gap PR #77 had.
3. **Added `descriptionText` to `TicketCreatedEvent`** (beyond A2's listed fields). The
   Jira issue body needs the ticket text; it's a generic ticket attribute (not
   Jira-specific), computed at emit via the existing `htmlToText`. Kept as neutral plain
   text so egress needs no HTML utils (which would violate the boundary).
4. **Fan-out is now product-agnostic, gated by client enrollment** — PR #77 hard-gated on
   `product.key === "huntress"`. Per your "the Jira module must not know Huntress or Halo
   exist," the rework fans out for **any** enrolled client's ticket (Tier2 included). This
   is a deliberate behavior change: with `ENABLE_JIRA=true`, a Tier2 ticket for a client
   listed in `JIRA_TARGETS` will now also mirror to Jira. It stays fully opt-in
   (default-off + per-client enrollment). If you want Huntress-only, add a `productKey`
   check in `jiraSubscriber` — but that reintroduces source knowledge into egress.
5. **`notiflyUrls` moved to `core/notify.ts`** — both the ingress ticket dead-letter and
   the egress Jira dead-letter need it; egress importing it from `ingress/halo.ts` would
   break the boundary. Same reason `stripTrailingSlashes` is now exported from
   `core/gorelo.ts`.
6. **Huntress uses the same mapper as Tier2** — the code showed no genuine divergence: a
   Huntress free-text payload simply has no HDB report table, so the mapper's report parse
   yields `{}` and the description falls to the free-text branch. One mapper handles both.
7. **Migration split** — `0001` owns `created_tickets` in its pre-Jira base shape; `0002`
   owns the Jira additions and mirrors `initSchema`'s v4 `created_tickets` (with
   `jira_issue_key`) via `CREATE IF NOT EXISTS` + `pending_jira`. Caveat: on a
   *migrations-only* fresh DB, `0001` creates `created_tickets` without `jira_issue_key`
   and `0002`'s `CREATE IF NOT EXISTS` no-ops, so `jira_issue_key` would be absent from
   migrations alone — but the runtime `initSchema` (authoritative; runs on the first
   request/cron of every real deployment, and which the README already documents as the
   self-migrator) performs the additive `ALTER` that adds it. In practice every real DB
   has the column. Flagged so you can decide if you want migrations to be self-sufficient
   without the runtime.

---

## Unrelated bugs / observations (not fixed, per instructions)

- **`0001` "missing attempts" was already false** on `main` — `pending_tickets.attempts`
  is present in the current `0001`. Only `created_tickets` was actually missing. (Noted,
  not a bug.)
- **Migrations-only fresh DB misses `jira_issue_key`** unless the runtime `initSchema`
  runs — see decision #7. Benign in practice (the Worker always runs `initSchema`), but
  it means the SQL migrations are not fully self-sufficient. Left as-is.
- No other unrelated defects were spotted during the refactor. The pre-existing
  "verify against the live Gorelo/Halo swagger before deploy" TODOs in the code are
  unchanged and out of scope.

---

## TOMORROW — testing the Jira path against a fresh free Jira Cloud site

### Setup (once)
1. Create a **free Jira Cloud site**: <https://www.atlassian.com/software/jira/free> →
   you get `https://<you>.atlassian.net`. Create a project and note its **key** (e.g.
   `SEC`). Note an **issue type** the project has (e.g. `Task`) and a **transition name**
   in its workflow (e.g. `Done`).
2. Create an **API token**:
   <https://id.atlassian.com/manage-profile/security/api-tokens>.
3. Pick a **Gorelo `clientId` you can trigger a ticket for** (a client that resolves from
   a test press/alert, or that you pass directly).

### Configure
4. `ENABLE_JIRA="true"` in `wrangler.toml` (or `.dev.vars` for local `wrangler dev`).
5. `JIRA_TARGETS` (secret, or `.dev.vars` locally):
   ```json
   [{"clientId":<your clientId>,"baseUrl":"https://<you>.atlassian.net","projectKey":"SEC",
     "issueType":"Task","email":"<your atlassian login>","apiToken":"<token>",
     "resolvedTransition":"Done"}]
   ```
   Local: `wrangler dev`. Deployed: `wrangler secret put JIRA_TARGETS` then `wrangler deploy`.

### Exercise
6. **Create** — drive a ticket for that client (a real Tier2 press / Huntress alert, or a
   `POST /tickets` from the client's source IP in `wrangler dev`). Expect: a new Jira
   issue in your project, summary = the ticket subject, description = `Gorelo ticket
   <number>` + the body, labels = `<productKey>` + `gorelo-<number>`. Confirm the issue
   key landed on the ledger: `GET /api/Tickets/{id}` returns `gorelo_ticket_id`… (and the
   D1 `created_tickets.jira_issue_key` is set).
7. **Resolve** — send a resolution edit for that ticket (Huntress marks the incident
   resolved by `POST`ing the original ticket id with a resolved status). Expect: a
   resolution **comment** on the Jira issue, and — if `resolvedTransition` matches an
   available transition — the issue **transitions** to `Done`.
8. **Durability** — to see the retry path, temporarily point `baseUrl` at an unreachable
   host, create a ticket (fan-out fails → row in `pending_jira`), fix `baseUrl`, and wait
   for the `*/5` cron (or hit it) → `flushPendingJira` creates the issue. After
   `MAX_JIRA_ATTEMPTS` (5) failures a job dead-letters and (if `NOTIFLY_URLS` is set)
   fires a notifly alert.

### What is verified by tests vs still theoretical

**Verified by the automated suite (148 tests):** the event spine (both events fire with
correct payloads), the mapper seam (HDB + free-text golden fixtures), the ingress↔egress
boundary, and — with a **mocked** Jira client — the full egress control flow: subscriber
wiring on create, ledger-key storage, enrollment gating (off / unenrolled), resolution →
comment + transition, the `pending_jira` drain, the create dedup guard, and the
dead-letter.

**✅ Verified live (2026-09-09, PR #87 comment).** The full create → resolve flow was run
against a real free-tier Jira Cloud site (via `wrangler dev` + `.dev.vars` enrolling a real
Gorelo clientId), confirming every call that was previously mock-only:
- `POST /rest/api/3/issue` — created issue `HD-2` (project `HD`, type `Security`); ADF
  `description` + `issuetype`/`project`/`labels` accepted, `key` returned.
- `POST /rest/api/3/issue/{key}/comment` — resolution comment posted on `HD-2`.
- `GET` + `POST /rest/api/3/issue/{key}/transitions` — `HD-2` transitioned `To Do → Done`
  (case-insensitive match on `resolvedTransition`).
- Basic auth (`email:apiToken`) and the end-to-end create → resolve round trip both work;
  real Gorelo tickets `TK-1059`/`TK-1060` and Jira issue `HD-2` resulted (test tenant).

So the three REST calls are no longer theoretical — the whole Jira path is live-verified.
The **automated suite still uses a mocked Jira client** (it proves wiring/control flow, not
the live API); that live check is a manual pass on top of it, not part of CI.

> **Tenant-id gotcha (not a bug):** if your test Gorelo tenant differs from the one
> `wrangler.toml`'s `DEFAULT_GROUP_ID`/`DEFAULT_TYPE_ID`/`HUNTRESS_TAG_ID`/`FALLBACK_TAG_ID`
> were set for (the Salient production tenant), the Gorelo create fails with error `070101`
> ("Group id X is invalid" / "tag(s) do not exist"). Override those ids in `.dev.vars` for a
> different sandbox tenant.

The **Gorelo** side of these tests is still only mock-verified in CI (a pre-existing property
of the repo's tests), but the live pass above exercised the real Gorelo create/read-back too.
