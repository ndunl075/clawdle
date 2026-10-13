# Windows probes for scripts/acceptance/security.mjs. Read-only: ACL dump, socket listing, socket sampling.
# Every command prints one JSON document to stdout (or writes it to -Out).
param(
    [Parameter(Mandatory)][ValidateSet('acl', 'sockets', 'sample', 'os')][string]$Command,
    [string]$Path,
    [int]$RootPid,
    [int]$Seconds = 60,
    [int]$IntervalMs = 400,
    [string]$Out
)
$ErrorActionPreference = 'Stop'

function Get-Tree([int]$Root) {
    $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$ids.Add($Root)
    do {
        $added = $false
        foreach ($p in $all) {
            if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $added = $true }
        }
    } while ($added)
    $all | Where-Object { $ids.Contains([int]$_.ProcessId) }
}

function Get-Role($proc) {
    if ($proc.Name -ne 'msedgewebview2.exe') { return 'app' }
    $c = [string]$proc.CommandLine
    if ($c -match '--type=([a-z-]+)') {
        $t = $Matches[1]
        if ($c -match '--utility-sub-type=([A-Za-z0-9_.]+)') { $t += ':' + $Matches[1] }
        return "webview2:$t"
    }
    return 'webview2:browser'
}

function Get-Sockets($tree) {
    $byId = @{}
    foreach ($p in $tree) { $byId[[int]$p.ProcessId] = $p }
    $rows = @()
    foreach ($c in @(Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        if ($byId.ContainsKey([int]$c.OwningProcess)) {
            $p = $byId[[int]$c.OwningProcess]
            $rows += [pscustomobject]@{ proto = 'tcp'; pid = [int]$c.OwningProcess; process = $p.Name; role = (Get-Role $p); state = [string]$c.State; local = "$($c.LocalAddress):$($c.LocalPort)"; remote = "$($c.RemoteAddress):$($c.RemotePort)"; localAddress = [string]$c.LocalAddress; localPort = [int]$c.LocalPort; remoteAddress = [string]$c.RemoteAddress; remotePort = [int]$c.RemotePort }
        }
    }
    foreach ($u in @(Get-NetUDPEndpoint -ErrorAction SilentlyContinue)) {
        if ($byId.ContainsKey([int]$u.OwningProcess)) {
            $p = $byId[[int]$u.OwningProcess]
            $rows += [pscustomobject]@{ proto = 'udp'; pid = [int]$u.OwningProcess; process = $p.Name; role = (Get-Role $p); state = 'Bound'; local = "$($u.LocalAddress):$($u.LocalPort)"; remote = ''; localAddress = [string]$u.LocalAddress; localPort = [int]$u.LocalPort; remoteAddress = ''; remotePort = 0 }
        }
    }
    $rows
}

switch ($Command) {
    'os' {
        $v = Get-CimInstance Win32_OperatingSystem
        [pscustomobject]@{ caption = $v.Caption; version = $v.Version; build = $v.BuildNumber; user = "$env:USERDOMAIN\$env:USERNAME"; sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } | ConvertTo-Json -Compress
    }
    'acl' {
        $acl = Get-Acl -LiteralPath $Path
        $icacls = (& icacls.exe $Path | Out-String).Trim()
        $icacls = $icacls.Replace($Path, '<path>')
        [pscustomobject]@{
            owner     = $acl.Owner
            protected = $acl.AreAccessRulesProtected
            rules     = @($acl.Access | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; rights = $_.FileSystemRights.ToString(); type = $_.AccessControlType.ToString(); inherited = $_.IsInherited } })
            icacls    = $icacls
            me        = "$env:USERDOMAIN\$env:USERNAME"
        } | ConvertTo-Json -Depth 5 -Compress
    }
    'sockets' {
        $tree = @(Get-Tree $RootPid)
        [pscustomobject]@{ processes = @($tree | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = $_.Name; role = (Get-Role $_) } }); sockets = @(Get-Sockets $tree) } | ConvertTo-Json -Depth 5 -Compress
    }
    'sample' {
        $seen = @{}
        $procs = @{}
        $samples = 0
        $end = (Get-Date).AddSeconds($Seconds)
        while ((Get-Date) -lt $end) {
            $tree = @(Get-Tree $RootPid)
            foreach ($p in $tree) { $procs["$($p.ProcessId)"] = "$($p.Name) $(Get-Role $p)" }
            foreach ($s in @(Get-Sockets $tree)) {
                $key = "$($s.proto)|$($s.pid)|$($s.state)|$($s.local)|$($s.remote)"
                if ($seen.ContainsKey($key)) { $seen[$key].count++ } else { $seen[$key] = [pscustomobject]@{ proto = $s.proto; pid = $s.pid; process = $s.process; role = $s.role; state = $s.state; local = $s.local; remote = $s.remote; remoteAddress = $s.remoteAddress; first = $samples; count = 1 } }
            }
            $samples++
            Start-Sleep -Milliseconds $IntervalMs
        }
        $doc = [pscustomobject]@{ samples = $samples; intervalMs = $IntervalMs; processes = $procs; observed = @($seen.Values) }
        $json = $doc | ConvertTo-Json -Depth 6 -Compress
        if ($Out) { [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false))) } else { $json }
    }
}
