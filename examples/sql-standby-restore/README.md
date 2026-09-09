# SQL standby-restore monitoring → Gorelo

A reference implementation for wiring an **on-prem SQL Server log-shipping / standby
restore job** into Gorelo alerting, using this relay's [`POST /v1/alerts`](../../README.md#monitoring-alerts)
ingress on one side and a native Gorelo RMM monitor on the other.

Everything here is **generic** — no customer, database, host, IP, or secret. Copy it
next to your restore automation and fill the placeholders from your NTFS-protected
config (never commit the filled-in copy).

## Why two paths

A restore job can't monitor itself: if it's disabled, crashed, or SQL Server Agent is
stopped, it produces no failure to alert on. And "no new log yet" is a normal, expected
state for a job that polls a vendor upload — alerting on it would be pure noise. So the
monitoring is split across two independent mechanisms that share one file:

| | **Path A — the restore job emits** | **Path B — the RMM watches** |
|---|---|---|
| Runs as | SQL Server Agent step (nightly + retries) | Gorelo RMM script (every few minutes) |
| Mechanism | `POST /v1/alerts` (this relay) | `GoreloAction -Alert` (native) |
| Catches | *why a run broke* — LSN gap, SQL error, download, extract, standby-verify — and auto-**resolves** on success | *nothing ran* (dead-man) + *standby stale* (recovery-point age) |
| Dedup | relay `dedupe_key` lifecycle | `GoreloAction -Suppress` (hours) |
| Depends on | the job actually running | **only the RMM agent** — survives Agent/job being down |

The seam is **`status.json`**, written by the job on every run and read by the RMM
watch. Its mtime is the liveness signal; `lastRestoredLogFinishUtc` is the freshness
signal. Because Path B reads only that file, it stays independent of SQL Agent and
even backstops Path A (a failed run still surfaces as freshness decay).

## Files

| File | Path | Purpose |
|---|---|---|
| `Send-GoreloAlert.ps1` | on the SQL host, next to the restore script | Relay client — dot-sourced by the restore job. POSTs to `/v1/alerts` with Bearer auth, retry, and idempotency. Never throws into the restore. |
| `restore-integration.example.ps1` | same | The status-file writer + error-classifier the restore job dot-sources and calls. |
| `Watch-SqlStandbyRestore.ps1` | pasted into a Gorelo RMM script | Path B — the liveness + freshness monitor using `GoreloAction`. |
| `Clean-SqlRestoreScratch.ps1` | Task Scheduler **or** a Gorelo RMM script | Retention cleanup — prunes old `Incoming\` archives + `Extracted\` folders. See [Cleanup](#cleanup). |
| `config.example.json` | — | The `Alert*` / `StatusFile` / `Stale*` keys to merge into your real config. |

---

## Path A — the restore job emits alerts

### 1. Onboard an alert source on the relay

`POST /v1/alerts` is two-factor: a per-source secret **bound to** that source's egress
IP allowlist (see the main [Monitoring alerts](../../README.md#monitoring-alerts)
section). Add the SQL host as its own source so its secret is useless from anywhere
else:

```toml
# wrangler.toml [vars]
ALERT_SOURCES = "default, acme"
# The SQL box's OUTBOUND public IP(s) — exact IPs and/or CIDRs, comma/space separated.
ALERT_IPS_ACME = "203.0.113.7, 203.0.113.8"
```

```bash
wrangler secret put ALERT_SECRET_ACME   # the value that goes in config AlertSharedSecret
```

Routing to a Gorelo client: set `ALERT_CLIENT_ID` (explicit), or let the alert's
`customer` match a client by exact name, else `CATCHALL_CLIENT_ID` catches it.

> Use the built-in `default` source (`ALERT_SHARED_SECRET` + `ALERT_ALLOWED_IPS`) only
> for a single-tenant deployment; a per-customer key is preferred.

### 2. Configure the job

Merge the alert keys from `config.example.json` into your restore config (the same
NTFS-protected JSON that already holds your backup secrets):

| Key | Meaning |
|---|---|
| `AlertRelayUrl` | `https://<worker-host>/v1/alerts` |
| `AlertSharedSecret` | the source secret (`ALERT_SECRET_<KEY>` value) |
| `AlertSource` | free-text label, e.g. `"SQL Standby Restore"` |
| `Customer` | Gorelo client name (routing) |
| `AlertHost` | host label the alert is raised for (defaults to `$env:COMPUTERNAME`) |
| `StatusFile` | where to write `status.json` (defaults to `<StateFolder>\status.json`) |

### 3. Wire it into the restore script

Dot-source both helpers near the top (after your SQL helpers like `Invoke-SqlTable`
are defined), then add three call sites:

```powershell
# after $ErrorActionPreference etc., and after Invoke-SqlTable/ConvertTo-SqlString exist
. (Join-Path $PSScriptRoot 'Send-GoreloAlert.ps1')
. (Join-Path $PSScriptRoot 'restore-integration.example.ps1')
```

- **On a healthy run** (after standby is verified) — write status and clear any open alert:
  ```powershell
  Write-RestoreStatusFile -Config $script:Config -Outcome 'restored' `
      -Connection $connection -LogsAppliedThisRun $pending.Count -StandbyState $finalState
  Resolve-GoreloAlerts -Config $script:Config -MonitorIds @('daily-restore','lsn-gap','azure-download','extract','standby-state')
  ```
- **On the no-new-log path** — write status, stay silent (Path B owns staleness):
  ```powershell
  Write-RestoreStatusFile -Config $script:Config -Outcome 'no-new-log' -Connection $connection -StandbyState $finalState
  ```
- **In the main `catch`** — classify and trigger:
  ```powershell
  Invoke-RestoreErrorAlert -Config $script:Config -ErrorMessage $_.Exception.Message | Out-Null
  Write-RestoreStatusFile -Config $script:Config -Outcome 'failed' -Connection $connection -ErrorMessage $_.Exception.Message
  ```

### Alert taxonomy (Path A)

| Condition | `monitor_id` | Severity | Status |
|---|---|---|---|
| All SAS downloads / AzCopy failed | `azure-download` | critical | triggered |
| Archive extraction / log validation failed | `extract` | critical | triggered |
| Broken log chain (LSN gap) | `lsn-gap` | critical | triggered |
| `RESTORE LOG` / other failure | `daily-restore` | critical | triggered |
| Standby not ONLINE/read-only/standby | `standby-state` | critical | triggered |
| ≥1 log applied successfully | *(all keys)* | info | **resolved** |
| **No new log yet** (retry window) | — | — | **silent** (status only) |

The relay dedups on `dedupe_key` (`<host>:<monitor_id>`), so the 12× SQL-Agent retry
storm collapses to one alert; a later successful attempt resolves it.

---

## Path B — the RMM freshness / dead-man watch

Create a Gorelo RMM **PowerShell script** from `Watch-SqlStandbyRestore.ps1` and
schedule it on the SQL host every few minutes. It reads `status.json` and raises native
alerts for the two things Path A can't see.

> **No `param()` block.** Gorelo wraps the script (it injects the `GoreloAction` cmdlet
> and `$gorelo:` variables) before running it, so your code is no longer at the top of
> the file — and PowerShell requires `param()` to be the first statement, so it fails to
> parse (`Unexpected token 'param'`). Configure via the plain **variables in the Config
> block** at the top of the script instead.

Config variables (defaults suit a nightly feed):

| Variable | Default | Meaning |
|---|---|---|
| `$StatusFile` | `F:\RestoreScratch\AutomationState\status.json` | must match the job's `StatusFile` |
| `$DeadManHours` | `26` | file older than this ⇒ *automation not running* (Severity 2) |
| `$WarnHours` | `26` | recovery point older ⇒ *stale* (Severity 3) |
| `$CriticalHours` | `48` | recovery point older ⇒ *critically stale* (Severity 1) |
| `$Suppress` | `24` | re-alert at most once per this many hours |
| `$SetCustomFields` | `$false` | `$true` to also mirror recovery point/outcome to asset fields |
| `$QuietStart` / `$QuietEnd` | `23:15` / `02:30` | maintenance/quiet window (local `HH:mm`, wraps midnight): suppress all alerts while the nightly import runs and retries. Blank either to disable. |

**Maintenance window.** The watch reads `status.json` (the last *completed* run's state),
not live SQL, so it never sees the mid-restore `SINGLE_USER`/`RESTORING` transitions — and
the file is written atomically, so it never reads a half-written one. The quiet window is
the belt-and-suspenders: during the nightly import + retry window it stays silent so a
restore-in-progress or a slightly-late feed can't page; a genuinely broken run still
surfaces the moment the window closes. Set the window to your job's schedule (default
covers a ~23:30 start plus ~2h of retries).

Gorelo severities: **1 = Critical, 2 = Error, 3 = Warning**.

If you set `$SetCustomFields = $true`, create these text custom fields on the asset first:
`asset.sqlStandbyRecoveryPoint`, `asset.sqlStandbyLastRun`, `asset.sqlStandbyOutcome`.

---

## Testing

Both paths write real alerts into Gorelo, so test deliberately (mirrors the repo's
[dev-safety note](../../README.md#local-development)):

- **Path A** — point `AlertRelayUrl` at a `wrangler dev` Worker, or use an obvious
  `TEST —` title. Trigger then resolve with the same `dedupe_key`; the relay returns
  `{ "accepted": true, "action": "created" | "resolved" | ... }`. Retries are safe.
- **Path B** — run `Watch-SqlStandbyRestore.ps1` interactively (outside the RMM agent
  it prints the alerts instead of raising them). Set **`$Suppress = 0`** while testing so
  repeats aren't swallowed; set it back to `24` for production. Force a stale condition by
  pointing `$StatusFile` at an old file, or a missing one, to see each branch.

## Cleanup

The restore script has **no retention of its own** — downloaded archives (`Incoming\`) and
extracted transaction-log folders (`Extracted\`) accumulate until the volume fills.
`Clean-SqlRestoreScratch.ps1` prunes them, reading the same `config.json` for paths and the
lookback:

- **`Incoming\` archives** (`*.zip`/`*.7z`) older than the **download lookback**
  (`DownloadLookbackHours`) — beyond the lookback they'd never be re-downloaded anyway;
  deleting anything *inside* it just makes AzCopy re-pull it, so the lookback is the floor.
- **`Extracted\<archive>_<fingerprint>\`** folders that carry the `.extract-complete`
  marker, older than the retention — their logs are already applied and tracked in `msdb`.
  Retention **defaults to the lookback window + `$ExtractedRetentionBufferDays` (1 day)**, so
  a folder whose archive is still inside the download window is never pruned (which would
  just make the next run re-download and re-extract it). Set `$ExtractedRetentionDays` to a
  positive number only if you want a fixed day count instead.

It **hard-protects** the standby (`.tuf`) folder and every `AdditionalTrnFolders` entry
(read from the config) and only ever operates inside `Incoming`/`Extracted`. It has **no
`param()` block**, so it runs equally as a Windows Task Scheduler task or a Gorelo RMM
script.

- **First run:** set `$WhatIf = $true` to log what it *would* delete without deleting.
- **Schedule** it **outside the import window** (e.g. daily 03:00 local, after the restore
  and its retries).

## Integrity & verification

Corruption is caught at several layers; know which flag/step covers what.

**Download (AzCopy, vendor blob → `Incoming\`).**
- **In transit:** AzCopy v10 sends a per-block MD5 with every block, so the service rejects
  any block corrupted on the wire — automatic, no flags needed.
- **End-to-end (blob == source file):** relies on the blob carrying a `Content-MD5`, which
  the **uploader** must opt into. In AzCopy **v10 that's opt-in** (`--put-md5`); it was the
  default in v8. Since the **vendor** uploads here, you don't control it — confirm whether
  their blobs have `Content-MD5`.
  - `--check-md5` is on by default in mode **`FailIfDifferent`**: it verifies *if* a hash is
    present and **silently passes if it's missing**.
  - `--check-md5 FailIfDifferentOrMissing` makes a *missing* hash an error too — but only use
    it if the vendor sets `--put-md5`, otherwise **every download fails**. If they don't set
    it, leave the default.
- **Regardless of MD5**, corruption is caught downstream: **7-Zip extraction** fails on a bad
  archive (CRC → non-zero exit → the script throws), and **`RESTORE`** rejects a bad backup
  (page/backup checksums). Ask the vendor to enable `--put-md5` if you want the earliest,
  explicit check.

**Local backups.** System-DB (and any self-owned `db_nysphi`) backups are written
`WITH CHECKSUM` and immediately `RESTORE VERIFYONLY`'d, so they're validated at creation.

**Off-host push (→ S3 / Wasabi).** Validate there too — it's your DR copy:
- The AWS CLI checks each part's integrity on upload (per-part MD5); optionally add
  `--checksum-algorithm SHA256` for an end-to-end client checksum where the endpoint
  supports S3 additional checksums.
- The real proof is a **periodic test-restore / `RESTORE VERIFYONLY` of a backup pulled back
  from the bucket** — the backups carry `WITH CHECKSUM` and the `.7z` carry CRCs, so that
  validates the off-site copy end-to-end.
- Note: MD5/CRC are **corruption** checks, not **tamper**-evidence — pair them with Object
  Lock + least-privilege keys for that. And `--put-md5` hashes the whole source, which costs
  time on very large files.

## Security

- The relay secret and any customer identifiers live only in the NTFS-protected config
  on the host — **never** in git, tickets, or email (same rule as your backup secrets).
- This folder is intentionally free of customer names, database names, real IPs, SAS
  URLs, and secrets. Keep the filled-in copies out of source control.
