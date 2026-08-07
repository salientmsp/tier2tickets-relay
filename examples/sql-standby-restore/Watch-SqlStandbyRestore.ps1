<#
.SYNOPSIS
Gorelo RMM monitor (Path B): watches a SQL standby-restore status file and raises
native Gorelo alerts via GoreloAction for two failure modes the restore job itself
cannot report.

.DESCRIPTION
Run this as a scheduled Gorelo RMM script on the SQL host (every few minutes). Because
it runs under the RMM agent — NOT SQL Server Agent — it stays up even when the restore
job is disabled, has crashed, or Agent is stopped, closing the gap a self-monitoring
job can't.

It reads ONE file, the status.json the restore job writes each run (see
restore-integration.example.ps1), and evaluates two independent signals:

  1. Liveness / dead-man  — the file's age (mtime). If nothing has run in DeadManHours,
     the automation is dead (Agent stopped, job disabled, box wedged). Severity 2.
  2. Freshness            — now - lastRestoredLogFinishUtc. If the standby's recovery
     point is older than WarnHours / CriticalHours, the feed has stalled (vendor
     outage, expired SAS, broken chain). Severity 3 / 1.

Plus a direct standbyState check (Severity 1 if the DB isn't ONLINE/read-only/standby).

Alerts are raised with GoreloAction -Alert. -Suppress collapses a persistent condition
to one alert per window (hours). It optionally mirrors the recovery point onto asset
custom fields so the standby's health is visible on the asset in Gorelo.

This script is generic: it names no customer or database. Point -StatusFile at the file
your restore job writes.

.NOTES
Gorelo severities: 1 = Critical, 2 = Error, 3 = Warning.
GoreloAction is only available inside a Gorelo RMM run; outside it (interactive
testing) this script prints the alert instead. Set $Suppress = 0 while testing.

NO param() BLOCK: Gorelo wraps this script (it injects the GoreloAction cmdlet and
$gorelo: variables) before running it, so your code is no longer at the top of the
file. PowerShell requires [CmdletBinding()]/param() to be the FIRST statement in a
file, so a param() block fails to parse under the agent ("Unexpected token 'param'").
Configure via the plain variables in the Config block below instead (or read them from
Gorelo script variables / $gorelo: custom fields).

Custom fields to create in Gorelo first (if $SetCustomFields = $true):
  asset.sqlStandbyRecoveryPoint   (text)
  asset.sqlStandbyLastRun         (text)
  asset.sqlStandbyOutcome         (text)
#>

# ── Config ──────────────────────────────────────────────────────────────────────
$StatusFile      = 'F:\RestoreScratch\AutomationState\status.json'
$DeadManHours    = 26
$WarnHours       = 26
$CriticalHours   = 48
$Suppress        = 24      # hours; set to 0 while testing so repeats aren't suppressed
$SetCustomFields = $false  # $true to also mirror status onto asset custom fields

# Maintenance/quiet window (local HH:mm, wraps midnight): while the nightly import runs
# and retries, suppress alerts so a restore-in-progress / late feed never pages. Genuine
# problems still surface once the window closes. Blank either value to disable. Default
# covers the ~23:30 job start plus up to ~2h of 10-minute retries, with buffer.
$QuietStart = '23:15'
$QuietEnd   = '02:30'

$ErrorActionPreference = 'Stop'

# GoreloAction wrapper: use the real cmdlet under the RMM agent; print otherwise so the
# script is testable interactively.
$script:HasGoreloAction = [bool](Get-Command -Name GoreloAction -ErrorAction SilentlyContinue)

function Raise-Alert {
    param(
        [Parameter(Mandatory = $true)][ValidateRange(1, 3)][int]$Severity,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Description
    )
    # Stay silent during the nightly import/retry window; genuine problems surface once
    # the window closes and the watch evaluates again.
    if ($script:InQuietWindow) {
        Write-Host ("[quiet window] suppressed alert: ({0}) {1}" -f $Severity, $Name)
        return
    }
    if ($script:HasGoreloAction) {
        GoreloAction -Alert -Severity $Severity -Name $Name -Description $Description -Suppress $Suppress
    }
    else {
        $label = @{ 1 = 'CRITICAL'; 2 = 'ERROR'; 3 = 'WARNING' }[$Severity]
        Write-Host ("[GoreloAction -Alert] ({0}) {1}`n{2}`n" -f $label, $Name, $Description)
    }
}

function Set-AssetField {
    param([Parameter(Mandatory = $true)][string]$Name, [string]$Value)
    if (-not $SetCustomFields) { return }
    if ([string]::IsNullOrWhiteSpace($Value)) { return }
    if ($script:HasGoreloAction) {
        GoreloAction -SetCustomField -Name $Name -Value $Value
    }
    else {
        Write-Host ("[GoreloAction -SetCustomField] {0} = {1}" -f $Name, $Value)
    }
}

function Get-HoursAgo {
    param([datetime]$WhenUtc)
    return [Math]::Round(((Get-Date).ToUniversalTime() - $WhenUtc).TotalHours, 1)
}

# True if the current LOCAL time is inside the maintenance/quiet window. Handles a window
# that wraps past midnight (Start > End). Blank Start/End disables it.
function Test-QuietWindow {
    param([string]$Start, [string]$End)
    if ([string]::IsNullOrWhiteSpace($Start) -or [string]::IsNullOrWhiteSpace($End)) { return $false }
    try {
        $now = (Get-Date).TimeOfDay
        $s = [datetime]::ParseExact($Start, 'HH:mm', $null).TimeOfDay
        $e = [datetime]::ParseExact($End,   'HH:mm', $null).TimeOfDay
    }
    catch { return $false }
    if ($s -le $e) { return ($now -ge $s -and $now -lt $e) }  # same-day window
    return ($now -ge $s -or $now -lt $e)                      # wraps past midnight
}

$script:InQuietWindow = Test-QuietWindow -Start $QuietStart -End $QuietEnd

# --- 1. Liveness: is the status file present and recent? --------------------------

if (-not (Test-Path -LiteralPath $StatusFile -PathType Leaf)) {
    Raise-Alert -Severity 2 -Name 'SQL standby restore: status file missing' -Description (
        "No restore status file at $StatusFile. The restore automation has never run, " +
        "has never written its status, or the path is wrong. Verify the SQL Agent job and its schedule.")
    Set-AssetField -Name 'asset.sqlStandbyOutcome' -Value 'status-file-missing'
    exit 0
}

$fileInfo    = Get-Item -LiteralPath $StatusFile
$fileAgeHrs  = Get-HoursAgo -WhenUtc $fileInfo.LastWriteTimeUtc

# Parse the status body defensively; a corrupt/half-written file is itself a problem.
try {
    $status = Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
}
catch {
    Raise-Alert -Severity 2 -Name 'SQL standby restore: status file unreadable' -Description (
        "The restore status file at $StatusFile could not be parsed as JSON: $($_.Exception.Message)")
    exit 0
}

$outcome      = if ($status.PSObject.Properties['outcome'])      { [string]$status.outcome }      else { 'unknown' }
$standbyState = if ($status.PSObject.Properties['standbyState']) { [string]$status.standbyState } else { '' }
$database     = if ($status.PSObject.Properties['database'])     { [string]$status.database }     else { '(unknown db)' }

Set-AssetField -Name 'asset.sqlStandbyLastRun' -Value $fileInfo.LastWriteTimeUtc.ToString('o')
Set-AssetField -Name 'asset.sqlStandbyOutcome' -Value $outcome

# Dead-man: nothing has written the file within the allowed window.
if ($fileAgeHrs -gt $DeadManHours) {
    Raise-Alert -Severity 2 -Name 'SQL standby restore automation not running' -Description (
        "The restore status file for $database has not been updated in $fileAgeHrs h " +
        "(threshold $DeadManHours h). The nightly restore job has not run — check SQL Server Agent " +
        "is running, the job is enabled, and the host is healthy. Last outcome recorded: $outcome.")
    exit 0
}

# --- 2. Freshness: how far behind is the standby recovery point? ------------------

$recoveryPointUtc = $null
if ($status.PSObject.Properties['lastRestoredLogFinishUtc'] -and
    -not [string]::IsNullOrWhiteSpace([string]$status.lastRestoredLogFinishUtc)) {
    try { $recoveryPointUtc = ([datetime]$status.lastRestoredLogFinishUtc).ToUniversalTime() } catch { $recoveryPointUtc = $null }
}

if ($recoveryPointUtc) {
    Set-AssetField -Name 'asset.sqlStandbyRecoveryPoint' -Value $recoveryPointUtc.ToString('o')
    $behindHrs = Get-HoursAgo -WhenUtc $recoveryPointUtc

    if ($behindHrs -gt $CriticalHours) {
        Raise-Alert -Severity 1 -Name 'SQL standby recovery point critically stale' -Description (
            "The standby database $database is $behindHrs h behind (critical threshold $CriticalHours h). " +
            "No recent transaction log has been restored — the vendor feed has likely stopped, the SAS has " +
            "expired, or the log chain is broken. Investigate the log-shipping source immediately.")
    }
    elseif ($behindHrs -gt $WarnHours) {
        Raise-Alert -Severity 3 -Name 'SQL standby recovery point stale' -Description (
            "The standby database $database is $behindHrs h behind (warning threshold $WarnHours h). " +
            "The daily transaction-log feed may be late. Confirm the vendor upload and the restore job.")
    }
}
else {
    # File is recent but carries no recovery point — restore has run but never applied a log.
    Raise-Alert -Severity 3 -Name 'SQL standby has no recorded recovery point' -Description (
        "The restore status file for $database is current ($fileAgeHrs h old) but records no restored " +
        "transaction log yet. Confirm the initial restore and that logs are being applied.")
}

# --- 3. Standby state sanity ------------------------------------------------------

# Healthy is ONLINE + read-only + standby; the restore job writes this string when it
# verifies. Anything else means a restore left the DB in a bad state.
if (-not [string]::IsNullOrWhiteSpace($standbyState) -and $standbyState -notmatch 'STANDBY') {
    Raise-Alert -Severity 1 -Name 'SQL standby database not in standby state' -Description (
        "The last restore left $database in state '$standbyState' rather than ONLINE read-only standby. " +
        "Reporting against the standby may be broken. Review the restore log.")
}

exit 0
