# Headless self-test for native-performance.lib.ps1. Launches no process and touches no files.
# Run: powershell -NoProfile -File scripts/native-performance.tests.ps1   (or pwsh)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'native-performance.lib.ps1')

$app = 'C:\fake\Clawdle.exe'
$failures = 0
function Check([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Output "PASS $Name" } else { Write-Output "FAIL $Name"; $script:failures++ }
}
function Row([string]$Path) { [pscustomobject]@{ProcessId = 4242; ParentProcessId = 1; CreationDate = [datetime]::UtcNow; ExecutablePath = $Path} }
$script:recoverCalls = 0
$neverCalled = { param($r) $script:recoverCalls++; throw 'recovery must not be consulted when CIM supplied a path' }

$webview = 'C:\Program Files (x86)\Microsoft\EdgeWebView\Application\1\msedgewebview2.exe'
$r = Resolve-DescendantExecutable -Row (Row $webview) -AppPath $app -RecoverPath $neverCalled
Check 'cim webview2 path accepted without recovery' ($r.Outcome -eq 'accept' -and $r.Source -eq 'cim' -and $script:recoverCalls -eq 0)

$r = Resolve-DescendantExecutable -Row (Row $app.ToUpper()) -AppPath $app -RecoverPath $neverCalled
Check 'cim app path accepted case-insensitively' ($r.Outcome -eq 'accept')

$r = Resolve-DescendantExecutable -Row (Row $null) -AppPath $app -RecoverPath { param($r) @{Status = 'exited'} }
Check 'empty path, process exited -> exited (dropped, not fatal)' ($r.Outcome -eq 'exited')

$r = Resolve-DescendantExecutable -Row (Row '') -AppPath $app -RecoverPath { param($r) @{Status = 'path'; Path = $webview} }
Check 'empty path recovered as webview2 -> accept via fallback' ($r.Outcome -eq 'accept' -and $r.Source -eq 'fallback' -and $r.Path -eq $webview)

$r = Resolve-DescendantExecutable -Row (Row $null) -AppPath $app -RecoverPath { param($r) @{Status = 'unknown'} }
Check 'empty path unrecoverable -> unverified' ($r.Outcome -eq 'unverified')

$r = Resolve-DescendantExecutable -Row (Row $null) -AppPath $app -RecoverPath { param($r) @{Status = 'path'; Path = ''} }
Check 'recovery claiming path with empty value -> unverified' ($r.Outcome -eq 'unverified')

$r = Resolve-DescendantExecutable -Row (Row 'C:\Windows\System32\cmd.exe') -AppPath $app -RecoverPath $neverCalled
Check 'foreign cim executable -> foreign' ($r.Outcome -eq 'foreign' -and $r.Name -eq 'cmd.exe')

$r = Resolve-DescendantExecutable -Row (Row $null) -AppPath $app -RecoverPath { param($r) @{Status = 'path'; Path = 'C:\x\evil.exe'} }
Check 'foreign recovered executable -> foreign (not accepted)' ($r.Outcome -eq 'foreign')

Check 'final status failed wins' ((Get-FinalReportStatus -Failure 'x' -UnverifiedObservations 3) -eq 'failed')
Check 'unverified observations forbid completed' ((Get-FinalReportStatus -Failure $null -UnverifiedObservations 1) -eq 'incomplete')
Check 'clean run completed' ((Get-FinalReportStatus -Failure $null -UnverifiedObservations 0) -eq 'completed')

Check 'visible launch has no arguments and presentation visible' (@(Get-LaunchArguments).Count -eq 0 -and (Get-Presentation) -eq 'visible')
Check 'hook launch passes only --hook-launch and presentation hidden' ((@(Get-LaunchArguments -HookLaunch) -join '|') -eq '--hook-launch' -and (Get-Presentation -HookLaunch) -eq 'hidden')
Check 'hidden target is 200 MiB' ((Get-PrivateBytesTarget -Presentation 'hidden') -eq 200MB)
Check 'visible target is 200 MiB' ((Get-PrivateBytesTarget -Presentation 'visible') -eq 200MB)
Check 'hidden at target passes' ((Test-PrivateBytesTarget -PeakPrivateBytes 200MB -Presentation 'hidden') -eq $true)
Check 'hidden over target fails' ((Test-PrivateBytesTarget -PeakPrivateBytes (200MB + 1) -Presentation 'hidden') -eq $false)
Check '150 MiB passes visible but fails hidden' ((Test-PrivateBytesTarget -PeakPrivateBytes 150MB -Presentation 'visible') -eq $true -and (Test-PrivateBytesTarget -PeakPrivateBytes 150MB -Presentation 'hidden') -eq $false)
Check 'missing peak gives no verdict' ($null -eq (Test-PrivateBytesTarget -PeakPrivateBytes $null -Presentation 'visible'))
$okRun = [pscustomobject]@{privateBytesTargetPass = $true}
$badRun = [pscustomobject]@{privateBytesTargetPass = $false}
$openRun = [pscustomobject]@{privateBytesTargetPass = $null}
Check 'report passes only when completed and all launches pass' ((Get-ReportTargetPass -Runs @($okRun, $okRun) -Status 'completed') -eq $true)
Check 'one failing launch fails the report' ((Get-ReportTargetPass -Runs @($okRun, $badRun) -Status 'completed') -eq $false)
Check 'unmeasured launch cannot pass' ((Get-ReportTargetPass -Runs @($okRun, $openRun) -Status 'completed') -eq $false)
Check 'incomplete or failed report has no verdict' ($null -eq (Get-ReportTargetPass -Runs @($okRun) -Status 'incomplete') -and $null -eq (Get-ReportTargetPass -Runs @($okRun) -Status 'failed'))

# Real fallback against this very process (no launch): same creation time -> path; wrong creation time -> exited.
$self = Get-Process -Id $PID
$ok = Resolve-ProcessPathFallback -ProcessId $PID -CreationDate $self.StartTime
Check 'fallback resolves own path' ($ok.Status -eq 'path' -and $ok.Path -ieq $self.Path)
$stale = Resolve-ProcessPathFallback -ProcessId $PID -CreationDate $self.StartTime.AddMinutes(-5)
Check 'fallback treats recycled pid (creation mismatch) as exited' ($stale.Status -eq 'exited')
$q = (Get-QueryImagePathType)::Query($PID)
Check 'QueryFullProcessImageName returns own path' ($q -ieq $self.Path)

if ($failures -gt 0) { Write-Output "$failures check(s) failed"; exit 1 }
Write-Output 'native-performance self-test passed'
