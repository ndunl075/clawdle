# Pure helpers for native-performance.ps1, dot-sourced by it and by native-performance.tests.ps1.
# Must stay Windows PowerShell 5.1 and PowerShell 7 compatible. Launches nothing at load time.

function Get-QueryImagePathType {
    if (-not ('Clawdle.ProcessImage' -as [type])) {
        Add-Type -Namespace Clawdle -Name ProcessImage -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)]
static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError=true)]
static extern bool CloseHandle(IntPtr handle);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, System.Text.StringBuilder name, ref uint size);
public static string Query(int pid) {
    IntPtr handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (handle == IntPtr.Zero) return null;
    try {
        var builder = new System.Text.StringBuilder(1024);
        uint size = (uint)builder.Capacity;
        return QueryFullProcessImageNameW(handle, 0, builder, ref size) ? builder.ToString() : null;
    } finally { CloseHandle(handle); }
}
'@
    }
    return [Clawdle.ProcessImage]
}

# Second source for a process executable path when CIM returns none. Bounded: $Attempts * $DelayMs.
# Returns @{Status='exited'} (gone, or PID recycled to a different creation time),
# @{Status='path';Path=...}, or @{Status='unknown'} (alive but not inspectable).
function Resolve-ProcessPathFallback {
    param([int]$ProcessId, [datetime]$CreationDate, [int]$Attempts = 3, [int]$DelayMs = 100)
    for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
        $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
        if ($null -eq $process) { return @{Status = 'exited'} }
        try {
            $startUtc = $null
            try { $startUtc = $process.StartTime.ToUniversalTime() } catch { $startUtc = $null }
            if ($null -ne $startUtc) {
                if ([Math]::Abs(($startUtc - $CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 10) { return @{Status = 'exited'} }
                $path = $null
                try { $path = $process.Path } catch { $path = $null }
                if (-not $path) { $path = (Get-QueryImagePathType)::Query($ProcessId) }
                if ($path) { return @{Status = 'path'; Path = $path} }
            }
            $gone = $false
            try { $gone = $process.HasExited } catch { $gone = $false }
            if ($gone) { return @{Status = 'exited'} }
        } finally { $process.Dispose() }
        Start-Sleep -Milliseconds $DelayMs
    }
    return @{Status = 'unknown'}
}

# Classifies a candidate descendant row (ProcessId, ExecutablePath, ...). Pure apart from $RecoverPath,
# which is called only when the row has no path. Outcome is one of: accept, exited, unverified, foreign.
function Resolve-DescendantExecutable {
    param($Row, [string]$AppPath, [scriptblock]$RecoverPath)
    $path = [string]$Row.ExecutablePath
    $source = 'cim'
    if (-not $path) {
        $recovered = & $RecoverPath $Row
        if ($recovered.Status -eq 'exited') {
            return [pscustomobject]@{Outcome = 'exited'; Path = $null; Source = 'fallback'; Name = $null}
        }
        if ($recovered.Status -ne 'path' -or -not $recovered.Path) {
            return [pscustomobject]@{Outcome = 'unverified'; Path = $null; Source = 'fallback'; Name = $null}
        }
        $path = [string]$recovered.Path
        $source = 'fallback'
    }
    $name = [IO.Path]::GetFileName($path)
    $ok = $path.Equals($AppPath, [StringComparison]::OrdinalIgnoreCase) -or $name -ieq 'msedgewebview2.exe'
    return [pscustomobject]@{Outcome = $(if ($ok) { 'accept' } else { 'foreign' }); Path = $path; Source = $source; Name = $name}
}

# Overall report status once no fatal failure occurred: any unverifiable process forbids 'completed'.
function Get-FinalReportStatus {
    param([string]$Failure, [int]$UnverifiedObservations)
    if ($Failure) { return 'failed' }
    if ($UnverifiedObservations -gt 0) { return 'incomplete' }
    return 'completed'
}

# Presentation recorded in the report: hook launches start hidden to tray, ordinary launches visible.
function Get-Presentation {
    param([switch]$HookLaunch)
    if ($HookLaunch) { return 'hidden' }
    return 'visible'
}

# Arguments passed to the app executable (never a shell string).
function Get-LaunchArguments {
    param([switch]$HookLaunch)
    if ($HookLaunch) { return @('--hook-launch') }
    return @()
}

# Summed private bytes target (MB = MiB): 120 hidden to tray, 200 visible.
function Get-PrivateBytesTarget {
    param([ValidateSet('hidden','visible')][string]$Presentation)
    if ($Presentation -eq 'hidden') { return [long](120 * 1MB) }
    return [long](200 * 1MB)
}

# True when the launch's peak summed private bytes is within target. $null when there is no peak yet.
function Test-PrivateBytesTarget {
    param($PeakPrivateBytes, [string]$Presentation)
    if ($null -eq $PeakPrivateBytes) { return $null }
    return ([long]$PeakPrivateBytes -le (Get-PrivateBytesTarget -Presentation $Presentation))
}

# Report-level pass: only a 'completed' report whose every launch measured and passed. $null until then.
function Get-ReportTargetPass {
    param($Runs, [string]$Status)
    if ($Status -ne 'completed') { return $null }
    $runs = @($Runs)
    if ($runs.Count -eq 0) { return $null }
    foreach ($run in $runs) { if ($run.privateBytesTargetPass -ne $true) { return $false } }
    return $true
}
