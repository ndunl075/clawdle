# Read-only probes for scripts/acceptance/install.mjs (Windows PowerShell 5.1 compatible).
#   state   -> JSON snapshot of every per-user location the NSIS installer is known to write
#   visible -> JSON {visible, windows[]} for a process id: every top-level window with class, title, size
#   cpu     -> JSON {busyPct}: total CPU busy percentage averaged over 3 s (context for latency numbers)
#   bench   -> run an exe N times (after warmups) with exact stdin bytes; JSON per-run wall ms (Stopwatch around
#              Process.Start..WaitForExit), kernel lifetime ms (ExitTime-StartTime), exit code, stdout/stderr length
param([Parameter(Mandatory)][ValidateSet('state','visible','bench','cpu')][string]$Op, [int]$ProcessId = 0, [string]$SpecPath = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
switch ($Op) {
  'state' {
    $shell = New-Object -ComObject WScript.Shell
    function Lnk([string]$path) {
      if (-not (Test-Path -LiteralPath $path)) { return $null }
      return @{ path = $path; target = $shell.CreateShortcut($path).TargetPath }
    }
    function RegValues([string]$key) {
      if (-not (Test-Path -LiteralPath $key)) { return $null }
      $o = [ordered]@{}
      $p = Get-ItemProperty -LiteralPath $key
      foreach ($n in ($p.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' })) { $o[$n.Name] = "$($n.Value)" }
      return $o
    }
    $manu = 'HKCU:\Software\clawdle'
    $manuTree = $null
    if (Test-Path -LiteralPath $manu) {
      $manuTree = @{}
      foreach ($k in (@(Get-Item -LiteralPath $manu) + @(Get-ChildItem -LiteralPath $manu -Recurse))) { $manuTree[$k.Name] = RegValues $k.PSPath }
    }
    $run = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
    $runHits = @()
    if ($run) { $runHits = @($run.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' -and ("$($_.Name) $($_.Value)" -match 'clawdle') } | ForEach-Object { $_.Name }) }
    $startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Clawdle.lnk'
    $desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Clawdle.lnk'
    $la = [Environment]::GetFolderPath('LocalApplicationData'); $ra = [Environment]::GetFolderPath('ApplicationData')
    $procs = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^clawdle' } | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name; path = $_.ExecutablePath } })
    @{
      uninstallKey    = RegValues 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Clawdle'
      manufacturerKey = $manuTree
      runKeyHits      = $runHits
      startMenuLnk    = Lnk $startMenu
      desktopLnk      = Lnk $desktop
      appDataDirs     = @{
        'LOCALAPPDATA\org.clawdle.desktop' = (Test-Path -LiteralPath (Join-Path $la 'org.clawdle.desktop'))
        'APPDATA\org.clawdle.desktop'      = (Test-Path -LiteralPath (Join-Path $ra 'org.clawdle.desktop'))
        'LOCALAPPDATA\Clawdle'             = (Test-Path -LiteralPath (Join-Path $la 'Clawdle'))
      }
      clawdleProcesses = $procs
    } | ConvertTo-Json -Depth 6 -Compress
  }
  'visible' {
    Add-Type @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class ClawdleWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static string[] Of(uint target) {
    var r = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) {
        var c = new StringBuilder(256); GetClassName(h, c, 256);
        var t = new StringBuilder(256); GetWindowText(h, t, 256);
        RECT rc; GetWindowRect(h, out rc);
        r.Add(h.ToInt64() + "|" + c + "|" + t + "|" + (rc.R - rc.L) + "x" + (rc.B - rc.T) + "|" + (IsWindowVisible(h) ? "visible" : "hidden"));
      } return true; }, IntPtr.Zero);
    return r.ToArray();
  }
}
'@
    $w = @([ClawdleWin]::Of([uint32]$ProcessId))
    @{ windows = $w } | ConvertTo-Json -Compress
  }
  'cpu' {
    $v = (Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 3 | ForEach-Object { $_.CounterSamples[0].CookedValue } | Measure-Object -Average).Average
    @{ busyPct = [Math]::Round($v, 1) } | ConvertTo-Json -Compress
  }
  'bench' {
    $spec = Get-Content -Raw -Encoding UTF8 -LiteralPath $SpecPath | ConvertFrom-Json
    $stdin = $null
    if ($spec.stdinFile) { $stdin = [IO.File]::ReadAllBytes($spec.stdinFile) }
    function Once {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $spec.exe
      $psi.Arguments = (@($spec.args) -join ' ')
      $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
      $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
      foreach ($p in $spec.env.PSObject.Properties) { $psi.EnvironmentVariables[$p.Name] = [string]$p.Value }
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $proc = [Diagnostics.Process]::Start($psi)
      try {
        if ($stdin -and $stdin.Length) { try { $proc.StandardInput.BaseStream.Write($stdin, 0, $stdin.Length); $proc.StandardInput.BaseStream.Flush() } catch {} }
        if ($spec.closeStdin) { try { $proc.StandardInput.Close() } catch {} }
        $timedOut = $false
        if (-not $proc.WaitForExit([int]$spec.timeoutMs)) { $timedOut = $true; try { $proc.Kill() } catch {}; $proc.WaitForExit() }
        $sw.Stop()
        $o = $proc.StandardOutput.ReadToEnd(); $e = $proc.StandardError.ReadToEnd()
        $life = [Math]::Round(($proc.ExitTime - $proc.StartTime).TotalMilliseconds, 1)
        return @{ ms = [Math]::Round($sw.Elapsed.TotalMilliseconds, 2); life = $life; exit = $proc.ExitCode; out = $o.Length; err = $e.Length; timedOut = $timedOut }
      } finally { $proc.Dispose() }
    }
    for ($i = 0; $i -lt [int]$spec.warmup; $i++) { $null = Once }
    $runs = @(); for ($i = 0; $i -lt [int]$spec.count; $i++) { $runs += (Once) }
    @{ runs = $runs } | ConvertTo-Json -Depth 4 -Compress
  }
}
