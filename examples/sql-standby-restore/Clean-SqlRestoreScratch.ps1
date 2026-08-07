<#
.SYNOPSIS
Retention cleanup for a SQL standby-restore scratch area. The restore script has no
cleanup of its own, so downloaded archives and extracted transaction-log folders grow
without bound and eventually fill the volume. This prunes them safely.

.DESCRIPTION
Reads the restore config (for folder paths + the download lookback) and deletes:

  1. Incoming\ archives (*.zip, *.7z) older than the download lookback window — so they
     are never re-downloaded. (Deleting anything INSIDE the lookback just makes AzCopy
     re-pull it on the next run, so the floor is the lookback, not an arbitrary age.)
  2. Extracted\<archive>_<fingerprint>\ folders older than $ExtractedRetentionDays that
     carry the .extract-complete marker — their logs are already applied and tracked in
     msdb, so the files aren't needed again.

It NEVER deletes under the standby (.tuf) folder or any AdditionalTrnFolders (the seed
chain): those paths are read from the config and hard-protected. It only ever operates
inside IncomingFolder / ExtractedFolder.

Runs safely under Windows Task Scheduler OR as a Gorelo RMM script. Like the RMM watch,
it uses a plain Config block (NO param()), because the Gorelo agent wraps the script and
a top-of-file param() would fail to parse.

.NOTES
- FIRST RUN: set $WhatIf = $true to see exactly what it WOULD delete (deletes nothing).
- Schedule OUTSIDE the import window (e.g. 03:00 local, after the nightly restore + retries).
- Extracted retention defaults to the lookback window + $ExtractedRetentionBufferDays (1 day),
  so a folder whose archive is still inside the download window is never pruned. Set
  $ExtractedRetentionDays to a positive number only if you want a fixed day count instead.
- Age is by LastWriteTimeUtc.
#>

# ── Config ──────────────────────────────────────────────────────────────────────
$ConfigPath                   = 'C:\ProgramData\NYSPHI\config.json'  # restore config: folder paths + lookback
$ExtractedRetentionDays       = 0   # 0 => derive from the lookback (recommended); or set an explicit day count
$ExtractedRetentionBufferDays = 1   # when deriving: keep extracted folders this many days PAST the lookback window
$IncomingRetentionHours       = 0   # 0 => use the config's DownloadLookbackHours
$WhatIf                       = $false   # $true = report only, delete nothing (use on the first run)

$ErrorActionPreference = 'Stop'
$script:LogFile = $null

function Write-CleanupLog {
    param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    if ($script:LogFile) { try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch {} }
    Write-Host $line
}

function Get-FullPathLower {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
    try { return ([System.IO.Path]::GetFullPath($Path)).TrimEnd('\').ToLowerInvariant() }
    catch { return $Path.TrimEnd('\').ToLowerInvariant() }
}

# --- Load config -----------------------------------------------------------------
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    Write-Host "Config not found: $ConfigPath"; exit 1
}
$cfg = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

$incoming  = [string]$cfg.IncomingFolder
$extracted = [string]$cfg.ExtractedFolder
$logFolder = [string]$cfg.LogFolder
if (-not [string]::IsNullOrWhiteSpace($logFolder)) {
    $script:LogFile = Join-Path $logFolder ('NYSPHI-Cleanup-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
}

$lookbackHours =
    if ($IncomingRetentionHours -gt 0) { $IncomingRetentionHours }
    elseif ($cfg.PSObject.Properties['DownloadLookbackHours']) { [int]$cfg.DownloadLookbackHours }
    else { 168 }

# Extracted retention: an explicit day count if set, else the lookback window (rounded up
# to whole days) plus a buffer — so a folder whose archive is still inside the download
# window is never pruned (which would just make the next run re-download and re-extract it).
$lookbackDays  = [int][math]::Ceiling($lookbackHours / 24.0)
$retentionDays = if ($ExtractedRetentionDays -gt 0) { [int]$ExtractedRetentionDays }
                 else { $lookbackDays + [int]$ExtractedRetentionBufferDays }

# --- Protected paths (never delete at or under these) ----------------------------
$protected = New-Object System.Collections.Generic.List[string]
if ($cfg.PSObject.Properties['StandbyFile'] -and -not [string]::IsNullOrWhiteSpace([string]$cfg.StandbyFile)) {
    $protected.Add((Get-FullPathLower (Split-Path -Parent ([string]$cfg.StandbyFile))))
}
if ($cfg.PSObject.Properties['AdditionalTrnFolders']) {
    foreach ($f in $cfg.AdditionalTrnFolders) {
        if (-not [string]::IsNullOrWhiteSpace([string]$f)) { $protected.Add((Get-FullPathLower ([string]$f))) }
    }
}

function Test-Protected {
    param([string]$Path)
    $p = Get-FullPathLower $Path
    foreach ($prot in $protected) {
        if ($prot -and ($p -eq $prot -or $p.StartsWith($prot + '\'))) { return $true }
    }
    return $false
}

Write-CleanupLog ("Cleanup start. Incoming retention {0}h (~{1}d); Extracted retention {2}d; WhatIf={3}." -f $lookbackHours, $lookbackDays, $retentionDays, $WhatIf)
foreach ($prot in $protected) { Write-CleanupLog ("Protected (never deleted): {0}" -f $prot) }

$nowUtc   = (Get-Date).ToUniversalTime()
$freed    = [int64]0
$delFiles = 0
$delDirs  = 0

# --- 1. Incoming archives older than the lookback window -------------------------
if (-not [string]::IsNullOrWhiteSpace($incoming) -and (Test-Path -LiteralPath $incoming -PathType Container)) {
    $cutoff = $nowUtc.AddHours(-[double]$lookbackHours)
    $archives = @(Get-ChildItem -LiteralPath $incoming -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object { ($_.Extension -in '.zip', '.7z') -and $_.LastWriteTimeUtc -lt $cutoff })
    foreach ($a in $archives) {
        if (Test-Protected $a.FullName) { continue }
        $freed += $a.Length; $delFiles++
        if ($WhatIf) {
            Write-CleanupLog ("WHATIF delete archive: {0} ({1:n0} bytes, {2:yyyy-MM-dd})" -f $a.FullName, $a.Length, $a.LastWriteTimeUtc)
        }
        else {
            try { Remove-Item -LiteralPath $a.FullName -Force; Write-CleanupLog ("Deleted archive: {0}" -f $a.FullName) }
            catch { Write-CleanupLog -Level WARN -Message ("Could not delete {0}: {1}" -f $a.FullName, $_.Exception.Message) }
        }
    }
}
else { Write-CleanupLog -Level WARN -Message "IncomingFolder missing or not configured; skipping archive cleanup." }

# --- 2. Extracted TRN folders older than the retention ---------------------------
if (-not [string]::IsNullOrWhiteSpace($extracted) -and (Test-Path -LiteralPath $extracted -PathType Container)) {
    $cutoff = $nowUtc.AddDays(-[double]$retentionDays)
    foreach ($d in @(Get-ChildItem -LiteralPath $extracted -Directory -ErrorAction SilentlyContinue)) {
        if (Test-Protected $d.FullName) { continue }
        # Only prune folders a run finished extracting; skip an in-progress/partial one.
        if (-not (Test-Path -LiteralPath (Join-Path $d.FullName '.extract-complete') -PathType Leaf)) { continue }
        if ($d.LastWriteTimeUtc -ge $cutoff) { continue }
        $size = [int64]((Get-ChildItem -LiteralPath $d.FullName -File -Recurse -ErrorAction SilentlyContinue |
                    Measure-Object -Property Length -Sum).Sum)
        $freed += $size; $delDirs++
        if ($WhatIf) {
            Write-CleanupLog ("WHATIF delete extracted: {0} ({1:n0} bytes, {2:yyyy-MM-dd})" -f $d.FullName, $size, $d.LastWriteTimeUtc)
        }
        else {
            try { Remove-Item -LiteralPath $d.FullName -Recurse -Force; Write-CleanupLog ("Deleted extracted: {0}" -f $d.FullName) }
            catch { Write-CleanupLog -Level WARN -Message ("Could not delete {0}: {1}" -f $d.FullName, $_.Exception.Message) }
        }
    }
}
else { Write-CleanupLog -Level WARN -Message "ExtractedFolder missing or not configured; skipping extracted cleanup." }

Write-CleanupLog ("Cleanup {0}. {1} archive(s), {2} extracted folder(s), {3:n0} bytes {4}." -f `
    $(if ($WhatIf) { '(dry run)' } else { 'complete' }), $delFiles, $delDirs, $freed, $(if ($WhatIf) { 'would be freed' } else { 'freed' }))
exit 0
