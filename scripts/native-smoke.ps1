# Maintainer-only Windows packaged-app check. Never installs real Claude hooks.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$App,
    [Parameter(Mandatory)][string]$Bridge,
    [Parameter(Mandatory)][string]$DataDir,
    [string]$Python = 'python',
    [ValidateRange(20,200)][int]$Samples = 30,
    [switch]$StartApp,
    [switch]$StopStartedApp
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'This check requires PowerShell 7 on Windows.' }
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$allowed = [IO.Path]::GetFullPath((Join-Path $repo '.local')) + [IO.Path]::DirectorySeparatorChar
if (-not [IO.Path]::IsPathRooted($DataDir)) { throw 'DataDir must be an explicit absolute path.' }
$profile = [IO.Path]::GetFullPath($DataDir)
if (-not $profile.StartsWith($allowed,[StringComparison]::OrdinalIgnoreCase) -or
    -not ([IO.Path]::GetFileName($profile.TrimEnd('\')) -like 'native-smoke*')) {
    throw 'DataDir must be a repository-owned .local/native-smoke* fixture profile.'
}
for ($cursor=$profile; $cursor; $cursor=[IO.Path]::GetDirectoryName($cursor)) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Reparse points are forbidden in the smoke profile path.'
    }
}
$appPath = (Get-Item -LiteralPath $App).FullName
$bridgePath = (Get-Item -LiteralPath $Bridge).FullName
if ([IO.Path]::GetExtension($appPath) -ne '.exe' -or [IO.Path]::GetExtension($bridgePath) -ne '.exe') { throw 'App and Bridge must be native executables.' }
$pythonPath = (Get-Command $Python -CommandType Application).Source
$fixtureSession = 'clawdle-smoke-' + [Guid]::NewGuid().ToString()
$fixtureTurn = [Guid]::NewGuid().ToString()
$canary = 'SYNTHETIC_PRIVATE_CANARY_' + [Guid]::NewGuid().ToString('N')
$started = $null
$httpHandler = [Net.Http.HttpClientHandler]::new()
$httpHandler.UseProxy = $false
$http = [Net.Http.HttpClient]::new($httpHandler)
$http.Timeout = [TimeSpan]::FromSeconds(2)
function New-FixtureProcess([string]$Executable,[string[]]$Arguments) {
    $info = [Diagnostics.ProcessStartInfo]::new($Executable)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.Environment['CLAWDLE_TEST_MODE'] = '1'
    $info.Environment['CLAWDLE_DATA_DIR'] = $profile
    $info.Environment['WEBVIEW2_USER_DATA_FOLDER'] = Join-Path $profile 'webview'
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    return $info
}
function Invoke-Hook([hashtable]$Metadata) {
    $info = New-FixtureProcess $bridgePath @('hook','--provider','claude')
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.Write(($Metadata | ConvertTo-Json -Depth 8 -Compress))
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(3000)) { $process.Kill(); throw 'Hook exceeded 3-second harness safety limit.' }
    $clock.Stop()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    if ($process.ExitCode -ne 0 -or $stdout.Length -ne 0 -or $stderr.Length -ne 0) { throw 'Hook was not silent and successful.' }
    $process.Dispose()
    return $clock.Elapsed.TotalMilliseconds
}
function Invoke-Protocol([string]$Body,[string]$Credential,[string]$Origin='', [string]$HostOverride='', [string]$Query='') {
    $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post,($baseUrl + '/v1/events' + $Query))
    $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$Credential)
    if ($Origin) { $request.Headers.Add('Origin',$Origin) }
    if ($HostOverride) { $request.Headers.Host = $HostOverride }
    $request.Content = [Net.Http.ByteArrayContent]::new([Text.Encoding]::UTF8.GetBytes($Body))
    $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('application/json')
    $response = $http.Send($request)
    try { return @{ Status=[int]$response.StatusCode; Body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult() } }
    finally { $response.Dispose(); $request.Dispose() }
}
try {
    if ($StartApp) {
        $info = New-FixtureProcess $appPath @('--hook-launch')
        $started = [Diagnostics.Process]::Start($info)
    }
    $endpointPath = Join-Path $profile 'endpoint.json'
    $wait = [Diagnostics.Stopwatch]::StartNew()
    $endpoint = $null
    while ($null -eq $endpoint) {
        if (Test-Path -LiteralPath $endpointPath) {
            $candidate = Get-Content -Raw -LiteralPath $endpointPath | ConvertFrom-Json
            if (-not $started -or $candidate.pid -eq $started.Id) { $endpoint = $candidate; break }
        }
        if ($started -and $started.HasExited) { throw 'Started process exited before fixture receiver publication. Close another Clawdle instance before starting a separate profile.' }
        if ($wait.Elapsed.TotalSeconds -gt 15) { throw 'No receiver in the explicit fixture profile; launch App there or pass -StartApp.' }
        Start-Sleep -Milliseconds 50
    }
    if ($endpoint.protocolVersion -ne 1 -or $endpoint.port -lt 1 -or $endpoint.port -gt 65535) { throw 'Invalid fixture endpoint.' }
    $receiverProcess = Get-Process -Id $endpoint.pid
    if (-not $receiverProcess.Path.Equals($appPath,[StringComparison]::OrdinalIgnoreCase)) { throw 'Endpoint PID is not the explicitly selected app executable.' }
    if ($started -and $started.Id -ne $endpoint.pid) { throw 'Receiver is not the process started by this check.' }
    $token = [IO.File]::ReadAllText((Join-Path $profile 'token'))
    if ($token -notmatch '^[a-f0-9]{64}$') { throw 'Invalid fixture token.' }
    $baseUrl = 'http://127.0.0.1:' + $endpoint.port
    $healthRequest = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get,($baseUrl + '/v1/health'))
    $healthRequest.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$token)
    $healthResponse = $http.Send($healthRequest)
    try {
        if ([int]$healthResponse.StatusCode -ne 200) { throw 'Authenticated health check failed.' }
        $health = $healthResponse.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
        if ($health.runtimeEpoch -ne $endpoint.runtimeEpoch) { throw 'Stale runtime epoch.' }
    } finally { $healthResponse.Dispose(); $healthRequest.Dispose() }
    $wire = @{ protocolVersion=1;eventId=[Guid]::NewGuid().ToString();provider='claude';sessionId=$fixtureSession;turnId=$fixtureTurn;scope='root';type='agent.activity';sourceEvent='SessionStart';observedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');projectKey=$null;activityKind='session_ready' }
    $body = $wire | ConvertTo-Json -Compress
    $first = Invoke-Protocol $body $token
    $retry = Invoke-Protocol $body $token
    if ($first.Status -ne 202 -or $retry.Status -ne 202 -or ($first.Body | ConvertFrom-Json).seq -ne ($retry.Body | ConvertFrom-Json).seq) { throw 'Durable event retry deduplication failed.' }
    $checks = @(
        @{ Response=(Invoke-Protocol $body ('0'*64)); Expected=401; Name='wrong token' },
        @{ Response=(Invoke-Protocol $body $token 'https://synthetic.invalid'); Expected=401; Name='browser Origin' },
        @{ Response=(Invoke-Protocol $body $token '' 'synthetic.invalid'); Expected=401; Name='unexpected Host' },
        @{ Response=(Invoke-Protocol $body $token '' '' '?credential=synthetic'); Expected=401; Name='query credentials' },
        @{ Response=(Invoke-Protocol ('x'*9000) $token); Expected=413; Name='oversize body' },
        @{ Response=(Invoke-Protocol '{"protocolVersion":999}' $token); Expected=400; Name='invalid protocol' }
    )
    foreach ($check in $checks) { if ($check.Response.Status -ne $check.Expected) { throw ('Protocol rejection failed: ' + $check.Name) } }
    foreach ($hook in @('UserPromptSubmit','PermissionRequest','SubagentStop','StopFailure','Stop')) {
        $metadata = @{hook_event_name=$hook;session_id=$fixtureSession;prompt_id=$fixtureTurn;prompt=$canary;transcript_path=$canary;last_assistant_message=$canary;tool_input=@{synthetic=$canary};cwd=$canary}
        $null = Invoke-Hook $metadata
    }
    for ($i=0;$i -lt 3;$i++) { $null = Invoke-Hook @{hook_event_name='SessionStart';session_id=$fixtureSession} }
    $latencies = for ($i=0;$i -lt $Samples;$i++) { Invoke-Hook @{hook_event_name='SessionStart';session_id=$fixtureSession} }
    # Read-only SQLite inspection proves exit-0 delivery and sanitized persistence.
    $inspection = @'
import json, pathlib, sqlite3, sys
path, session, canary, expected = sys.argv[1:]
con = sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True, timeout=10)
rows = con.execute("SELECT seq,payload FROM event_journal WHERE kind='agent' ORDER BY seq").fetchall()
events = [(seq,json.loads(payload)) for seq,payload in rows if json.loads(payload).get('sessionId') == session]
assert len(events) == int(expected), f'Expected {expected} observed events, got {len(events)}; silent hook exit is not proof of delivery'
assert canary not in json.dumps(events), 'Raw synthetic provider content entered journal'
assert [event['sourceEvent'] for _,event in events[:6]] == ['SessionStart','UserPromptSubmit','PermissionRequest','SubagentStop','StopFailure','Stop'], 'Observed lifecycle receipt order changed'
child = [event for _,event in events if event['sourceEvent']=='SubagentStop']
assert len(child)==1 and child[0]['scope']=='child', 'Child scope was not preserved'
failure = [event for _,event in events if event['sourceEvent']=='StopFailure']
assert len(failure)==1 and failure[0]['endReason']=='provider_error', 'Provider failure normalization failed'
assert [seq for seq,_ in events] == sorted(set(seq for seq,_ in events)), 'Journal sequences are not unique and ordered'
print(json.dumps({'verifiedEvents':len(events),'privacyCanaryAbsent':True,'childIsolation':True,'providerFailureReason':True}))
'@
    $proof = & $pythonPath -c $inspection (Join-Path $profile 'clawdle.sqlite') $fixtureSession $canary ([string](1+5+3+$Samples))
    if ($LASTEXITCODE -ne 0) { throw 'Read-only journal proof failed.' }
    $sorted = @($latencies | Sort-Object)
    $p95 = $sorted[[Math]::Ceiling($Samples*0.95)-1]
    [ordered]@{
        protocolChecksPassed=$true; journalProof=($proof|ConvertFrom-Json);samples=$Samples;warmupProcesses=3
        metric='warmed native hook process launch through silent exit; includes stdin, delivery and process startup'
        minMs=[Math]::Round($sorted[0],2);p95Ms=[Math]::Round($p95,2);maxMs=[Math]::Round($sorted[-1],2)
        runningReceiverP95GoalMs=50;p95GoalMet=($p95 -lt 50);executionBudgetMs=300;allSamplesWithinBudget=($sorted[-1] -le 300)
        appSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $appPath).Hash;bridgeSha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $bridgePath).Hash
        limitations=@('Synthetic metadata only; no installed Claude execution or model access.','No hardware sleep, IDE focus, installer, working-set, or offline-machine claims.','Process startup and OS scheduling are included; p95 is measured on this machine and workload only.')
    } | ConvertTo-Json -Depth 6
} finally {
    $http.Dispose()
    $token = $null
    if ($StopStartedApp -and $started -and -not $started.HasExited) { Stop-Process -Id $started.Id; $started.WaitForExit(5000) | Out-Null }
    if ($started) { $started.Dispose() }
}
