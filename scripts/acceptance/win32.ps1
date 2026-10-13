# Win32 window visibility and foreground probes for the acceptance scripts (read-only except WM_CLOSE).
param([string]$Op, [int]$ProcessId = 0, [int]$Ms = 0, [string]$Out = '', [string]$StopFile = '')
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  public static IntPtr MainOf(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      if (p == target && c.ToString() == "Tauri Window") { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string List(uint target) {
    var sb = new StringBuilder();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (p == target) { var c = new StringBuilder(128); GetClassName(h, c, 128); sb.Append(h.ToInt64() + "|" + c + "|len" + GetWindowTextLength(h) + "|vis" + IsWindowVisible(h) + ";"); } return true; }, IntPtr.Zero);
    return sb.ToString(); }
  public static uint ForegroundPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
}
'@
switch ($Op) {
  'visible' { $h = [W]::MainOf($ProcessId); [pscustomobject]@{ hwnd = [int64]$h; visible = ($h -ne [IntPtr]::Zero -and [W]::IsWindowVisible($h)) } | ConvertTo-Json -Compress }
  'close'   { $h = [W]::MainOf($ProcessId); [void][W]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); 'posted' }
  'windows' { [W]::List($ProcessId) }
  'sysclose' { $h = [W]::MainOf($ProcessId); [void][W]::PostMessage($h, 0x0112, [IntPtr]0xF060, [IntPtr]::Zero); 'posted' }
  'hide'    { $h = [W]::MainOf($ProcessId); [void][W]::ShowWindow($h, 0); 'hidden' }   # raw SW_HIDE, test-only
  'fgpid'   { [W]::ForegroundPid() }
  'sample'  { # Record the foreground process id every 25 ms for $Ms milliseconds or until $StopFile exists.
    $end = [DateTime]::UtcNow.AddMilliseconds($Ms); $seen = @{}; $trans = @(); $last = -1
    while ([DateTime]::UtcNow -lt $end -and -not ($StopFile -and (Test-Path $StopFile))) { $p = [W]::ForegroundPid(); if ($p -ne $last) { $last = $p; $trans += ('{0}:{1}' -f [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(), $p) }; $seen["$p"] = 1 + [int]$seen["$p"]; Start-Sleep -Milliseconds 25 }
    $seen | ConvertTo-Json -Compress | Out-File -Encoding utf8 $Out; ($trans -join ',') | Out-File -Encoding utf8 "$Out.trans" }
}
