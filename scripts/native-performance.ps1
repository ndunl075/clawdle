# Maintainer measurement only. Does not install hooks or invoke a model.
# Requires PowerShell 7, Windows CIM, and Python 3 with sqlite3.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$App,
    [Parameter(Mandatory)][string]$DataDir,
    [string]$Python = 'python',
    [ValidateRange(1,10)][int]$Launches = 3,
    [ValidateRange(10,3600)][int]$DurationSeconds = 60,
    [ValidateRange(100,10000)][int]$SampleIntervalMs = 1000,
    [ValidateRange(5,120)][int]$ReadinessTimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'Requires PowerShell 7 on Windows.' }
function Assert-PlainPath([string]$Path) {
    for ($cursor=$Path; $cursor; $cursor=[IO.Path]::GetDirectoryName($cursor)) {
        if ((Test-Path -LiteralPath $cursor) -and
            ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Reparse point forbidden: $cursor"
        }
    }
}
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not [IO.Path]::IsPathRooted($App) -or -not [IO.Path]::IsPathRooted($DataDir)) {
    throw 'App and DataDir must be explicit absolute paths.'
}
$appPath = [IO.Path]::GetFullPath($App)
$fixture = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
$local = [IO.Path]::GetFullPath((Join-Path $repo '.local')).TrimEnd('\')
if (-not [IO.Path]::GetDirectoryName($fixture).Equals($local,[StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetFileName($fixture) -notlike 'native-smoke*') {
    throw 'DataDir must be a direct repository .local/native-smoke* fixture directory.'
}
Assert-PlainPath $fixture
Assert-PlainPath $appPath
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf) -or [IO.Path]::GetExtension($appPath) -ne '.exe') {
    throw 'App must be an existing native .exe.'
}
if (Test-Path -LiteralPath $fixture) { throw 'Use a new DataDir for every invocation; existing fixtures are preserved.' }
$pythonPath = (Get-Command $Python -CommandType Application | Select-Object -First 1).Source
$pythonVersion = & $pythonPath -c 'import sqlite3,sys; assert sys.version_info.major == 3; print(sys.version.split()[0])'
if ($LASTEXITCODE -ne 0) { throw 'Python 3 with sqlite3 is required.' }
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$runId = [Guid]::NewGuid().ToString()
$null = New-Item -ItemType Directory -Path $fixture
$marker = Join-Path $fixture 'harness-owner.json'
@{runId=$runId;app=$appPath;ownerSid=$ownerSid} | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding utf8
$dictionary = Join-Path $repo 'packages/game/src/words.generated.json'
Assert-PlainPath $dictionary
$logicalProcessors = [Environment]::ProcessorCount
$results = [Collections.Generic.List[object]]::new()
$reportPath = Join-Path $fixture 'performance.json'
function Assert-FixtureOwner {
    Assert-PlainPath $marker
    $value = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($value.runId -ne $runId -or $value.app -ne $appPath -or $value.ownerSid -ne $ownerSid) {
        throw 'Fixture ownership marker changed; refusing process cleanup or writes.'
    }
}
function Get-Identity($Row) {
    return "$($Row.ProcessId):$($Row.CreationDate.ToUniversalTime().Ticks)"
}
function Assert-ProcessOwner($Row) {
    $owner = Invoke-CimMethod -InputObject $Row -MethodName GetOwnerSid
    if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne $ownerSid) { throw 'Process owner is not the current user.' }
}
function Update-Tree {
    $rows = @(Get-CimInstance Win32_Process)
    $liveIdentities = @{}
    foreach ($row in $rows) { $liveIdentities[(Get-Identity $row)] = $true }
    $rootRow = $rows | Where-Object { $_.ProcessId -eq $started.Id } | Select-Object -First 1
    if ($null -ne $rootRow) {
        if (-not $rootRow.ExecutablePath -or -not $rootRow.ExecutablePath.Equals($appPath,[StringComparison]::OrdinalIgnoreCase) -or
            [Math]::Abs(($rootRow.CreationDate.ToUniversalTime() - $started.StartTime.ToUniversalTime()).TotalMilliseconds) -gt 10) {
            throw 'Launched PID no longer identifies the selected executable and creation time.'
        }
        $id = Get-Identity $rootRow
        if (-not $owned.ContainsKey($id)) { Assert-ProcessOwner $rootRow; $owned[$id]=$rootRow }
    }
    # Fixed point: include only native/WebView2 children of a verified identity.
    # Creation-time ordering prevents a reused parent PID adopting an older process.
    do {
        $added = $false
        foreach ($row in $rows) {
            $id = Get-Identity $row
            if ($owned.ContainsKey($id)) { continue }
            $parent = $owned.Values | Where-Object {
                $_.ProcessId -eq $row.ParentProcessId -and $_.CreationDate -le $row.CreationDate -and $liveIdentities.ContainsKey((Get-Identity $_))
            } | Select-Object -First 1
            if ($null -eq $parent) { continue }
            if (-not $row.ExecutablePath) { throw 'Cannot verify a descendant executable.' }
            $name = [IO.Path]::GetFileName($row.ExecutablePath)
            if (-not $row.ExecutablePath.Equals($appPath,[StringComparison]::OrdinalIgnoreCase) -and $name -ine 'msedgewebview2.exe') {
                throw "Unexpected descendant executable: $name"
            }
            Assert-PlainPath $row.ExecutablePath
            Assert-ProcessOwner $row
            $owned[$id] = $row
            $added = $true
        }
    } while ($added)
    return @($rows | Where-Object { $owned.ContainsKey((Get-Identity $_)) })
}
function Get-Sample([Diagnostics.Stopwatch]$Clock) {
    $rows = @(Update-Tree)
    $members = [Collections.Generic.List[object]]::new()
    foreach ($row in $rows) {
        try {
            $process = Get-Process -Id $row.ProcessId -ErrorAction Stop
            try {
                $null = $process.SafeHandle # Anchor the native process identity across subsequent reads.
                if ([Math]::Abs(($process.StartTime.ToUniversalTime()-$row.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 10) { continue }
                $members.Add([pscustomobject][ordered]@{identity=(Get-Identity $row);pid=[int]$row.ProcessId;name=$process.ProcessName;
                    workingSetBytes=$process.WorkingSet64;privateBytes=$process.PrivateMemorySize64;cpuSeconds=$process.TotalProcessorTime.TotalSeconds})
            } finally { $process.Dispose() }
        } catch {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($row.ProcessId)" | Select-Object -First 1
            if ($null -eq $current -or (Get-Identity $current) -ne (Get-Identity $row)) { continue }
            throw # A live process with unreadable counters must not silently disappear from totals.
        }
    }
    $at = $Clock.Elapsed.TotalSeconds
    $delta = 0.0
    foreach ($member in $members) {
        if ($previousCpu.ContainsKey($member.identity)) { $delta += [Math]::Max(0,($member.cpuSeconds-$previousCpu[$member.identity])) }
        $previousCpu[$member.identity] = $member.cpuSeconds
    }
    $seconds = $at-$previousAt.Value
    $cpuOneCore = if ($previousAt.Value -ge 0 -and $seconds -gt 0) { 100*$delta/$seconds } else { $null }
    $previousAt.Value = $at
    return [pscustomobject][ordered]@{elapsedSeconds=$at;processCount=$members.Count;
        workingSetBytes=[long](($members | Measure-Object workingSetBytes -Sum).Sum);
        privateBytes=[long](($members | Measure-Object privateBytes -Sum).Sum);
        cpuPercentOneCore=$cpuOneCore;cpuPercentMachine=$(if($null -ne $cpuOneCore){$cpuOneCore/$logicalProcessors}else{$null});processes=@($members.ToArray())}
}
function Stop-OwnedTree {
    Assert-FixtureOwner
    # Discover before terminating the root. Never use Kill(entireProcessTree),
    # process names, or endpoint PIDs as authority for termination.
    $null = Update-Tree
    $identities = @($owned.Values | Sort-Object @{Expression={if($_.ProcessId -eq $started.Id){0}else{1}}},CreationDate -Descending)
    # Stop root first so it cannot intentionally create more browser children.
    $identities = @($identities | Sort-Object @{Expression={if($_.ProcessId -eq $started.Id){0}else{1}}})
    foreach ($known in $identities) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($known.ProcessId)" | Select-Object -First 1
        if ($null -eq $current -or (Get-Identity $current) -ne (Get-Identity $known)) { continue }
        if (-not $current.ExecutablePath -or $current.ExecutablePath -ne $known.ExecutablePath) { throw 'Process path changed; refusing termination.' }
        Assert-ProcessOwner $current
        $process = Get-Process -Id $current.ProcessId -ErrorAction SilentlyContinue
        if ($process) {
            try {
                $null = $process.SafeHandle # Keep a handle to this identity; a recycled PID must not become a kill target.
                if ([Math]::Abs(($process.StartTime.ToUniversalTime()-$known.CreationDate.ToUniversalTime()).TotalMilliseconds) -le 10) {
                    $process.Kill()
                    if (-not $process.WaitForExit(5000)) { throw 'Owned process failed to exit.' }
                }
            } finally { $process.Dispose() }
        }
    }
}
$inspection = @'
import datetime,json,pathlib,sqlite3,sys
db,dictionary=sys.argv[1:]
result={'ready':False}
try:
    con=sqlite3.connect(pathlib.Path(db).resolve().as_uri()+'?mode=ro',uri=True,timeout=0.05)
    with con:
        row=con.execute('SELECT state_version,processed_seq,state FROM app_checkpoint WHERE id=1').fetchone()
    con.close()
    if row:
        state=json.loads(row[2]); game=state.get('games',{}).get(state.get('activeGameId'))
        words=json.loads(pathlib.Path(dictionary).read_text(encoding='utf-8'))
        assert row[0]>=1 and row[1]>=1 and state['schemaVersion']==1
        assert game and game['gameId']==state['activeGameId'] and game['mode']=='daily'
        assert game['rulesVersion']=='wordle-5x6-v1' and game['dictionaryVersion']=='en-v1'
        assert game['status']=='playing' and game['guesses']==[] and game['finishedAtUtc'] is None
        assert game['elapsedMs'] is None and game['timingValid'] is True and game['speedrunId'] is None
        day=datetime.date.fromisoformat(game['dailyKey'])
        started=datetime.datetime.fromisoformat(game['startedAtUtc'].replace('Z','+00:00'))
        assert started.tzinfo and started.date()==day
        index=(day-datetime.date(2026,10,12)).days % len(words['daily'])
        assert game['wordId']==words['daily'][index]
        assert game['wordId'][6:].upper() in words['answers']
        result={'ready':True,'stateVersion':row[0],'processedSeq':row[1],'gameId':game['gameId']}
except (sqlite3.Error,ValueError,KeyError,AssertionError,TypeError,OSError):
    pass
print(json.dumps(result))
'@
$failure = $null
try {
    for ($launch=1; $launch -le $Launches; $launch++) {
        Assert-FixtureOwner
        $profile = Join-Path $fixture ('launch-{0:d2}' -f $launch)
        $null = New-Item -ItemType Directory -Path $profile
        $owned = @{}
        $previousCpu = @{}
        $previousAt = [ref](-1.0)
        $started = $null
        $samples = [Collections.Generic.List[object]]::new()
        $info = [Diagnostics.ProcessStartInfo]::new($appPath)
        $info.UseShellExecute = $false
        $info.Environment['CLAWDLE_TEST_MODE']='1'
        $info.Environment['CLAWDLE_DATA_DIR']=$profile
        $info.Environment['WEBVIEW2_USER_DATA_FOLDER']=Join-Path $profile 'webview'
        $info.WorkingDirectory=[IO.Path]::GetDirectoryName($appPath)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        try {
            $started = [Diagnostics.Process]::Start($info)
            $ready = $null
            $endpoint = $null
            while ($null -eq $ready) {
                if ($started.HasExited) { throw 'Launched app exited before readiness. Close an existing Clawdle instance before measuring.' }
                $null = Update-Tree
                $endpointPath = Join-Path $profile 'endpoint.json'
                $databasePath = Join-Path $profile 'clawdle.sqlite'
                Assert-PlainPath $endpointPath
                Assert-PlainPath $databasePath
                Assert-PlainPath ($databasePath + '-wal')
                Assert-PlainPath ($databasePath + '-shm')
                if (Test-Path -LiteralPath $endpointPath) {
                    try { $endpoint = Get-Content -LiteralPath $endpointPath -Raw | ConvertFrom-Json } catch { $endpoint = $null }
                    if ($null -ne $endpoint -and ($endpoint.pid -ne $started.Id -or $endpoint.protocolVersion -ne 1 -or -not $endpoint.runtimeEpoch)) {
                        throw 'Fixture receiver does not belong to the launched app.'
                    }
                }
                if ($null -ne $endpoint -and (Test-Path -LiteralPath $databasePath)) {
                    $proof = & $pythonPath -c $inspection $databasePath $dictionary
                    if ($LASTEXITCODE -ne 0) { throw 'Read-only checkpoint inspection failed.' }
                    $candidate = $proof | ConvertFrom-Json
                    if ($candidate.ready) { $ready=$candidate; break }
                }
                if ($clock.Elapsed.TotalSeconds -ge $ReadinessTimeoutSeconds) { throw 'No valid initial daily puzzle checkpoint before readiness timeout.' }
                Start-Sleep -Milliseconds 100
            }
            $readinessMs = $clock.Elapsed.TotalMilliseconds
            $null = Get-Sample $clock # Baseline excluded from sustained interval.
            $measureStart = $clock.Elapsed.TotalSeconds
            while (($clock.Elapsed.TotalSeconds-$measureStart) -lt $DurationSeconds) {
                Start-Sleep -Milliseconds $SampleIntervalMs
                if ($started.HasExited) { throw 'App exited during sustained measurement.' }
                $samples.Add((Get-Sample $clock))
            }
            $cpu = @($samples | ForEach-Object {$_.cpuPercentMachine} | Where-Object {$null -ne $_})
            $results.Add([ordered]@{launch=$launch;profile=$profile;
                launchKind=$(if($launch -eq 1){'first process launch in this harness invocation; OS cache state uncontrolled'}else{'repeated OS-warmed launch; fresh app/WebView2 profile'});
                readinessProxyMs=$readinessMs;checkpoint=$ready;runtimeEpoch=$endpoint.runtimeEpoch;
                measuredDurationSeconds=($clock.Elapsed.TotalSeconds-$measureStart);sampleCount=$samples.Count;
                peakWorkingSetBytes=($samples | Measure-Object workingSetBytes -Maximum).Maximum;
                peakPrivateBytes=($samples | Measure-Object privateBytes -Maximum).Maximum;
                meanCpuPercentMachine=($cpu | Measure-Object -Average).Average;samples=@($samples.ToArray())})
        } finally {
            if ($started) { try { Stop-OwnedTree } finally { $started.Dispose() } }
        }
    }
} catch { $failure=$_.Exception.Message }
Assert-FixtureOwner
[ordered]@{format='clawdle-native-performance-v1';createdUtc=[DateTimeOffset]::UtcNow.ToString('o');
    app=$appPath;appSha256=(Get-FileHash -LiteralPath $appPath -Algorithm SHA256).Hash;
    powershellVersion=$PSVersionTable.PSVersion.ToString();pythonVersion=[string]$pythonVersion;
    os=[Environment]::OSVersion.VersionString;logicalProcessors=$logicalProcessors;
    durationSeconds=$DurationSeconds;sampleIntervalMs=$SampleIntervalMs;failure=$failure;runs=@($results.ToArray());
    readinessMetric='process launch to observed durable valid initial daily puzzle checkpoint; NOT visible pixels or interactive readiness';
    limitations=@('No cold boot claim: OS caches, antivirus, background load and hardware are uncontrolled.',
        'Fresh profile per launch; later launches warm OS caches, not restored app/WebView2 profiles.',
        'Readiness includes polling, CIM enumeration, SQLite query and Python subprocess overhead; observation is an upper bound.',
        'Ordinary visible launch requested but visibility is unverified; idle workload only, no typing, models, installed Claude integration or focus claim.',
        'Working sets sum process resident bytes and can count shared pages repeatedly; private bytes are committed private memory, not resident memory.',
        'CPU uses deltas for surviving sampled process identities; short-lived/exiting process CPU between samples can be missed.',
        'CPU mean is the arithmetic mean of sampled intervals; inspect raw elapsed times for weighted analysis.',
        'Only verified native/WebView2 descendants are included; system services, GPU driver memory and unrelated processes are excluded.',
        'CIM and Python inspection consume harness resources outside the app process tree.')
} | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Output $reportPath
if ($failure) { throw $failure }
