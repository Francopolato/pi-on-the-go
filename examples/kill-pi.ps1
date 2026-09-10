# kill-pi.ps1 — closes any running pi-coding-agent instances.
# Kills the pi node process AND its parent cmd window (the one from the launcher
# bat), so no "ghost" windows pile up when you re-run the launcher script.
# Generic: no hardcoded paths. Called from run-pi.bat via "%~dp0kill-pi.ps1".

$nodes = Get-CimInstance Win32_Process -Filter 'Name="node.exe"' -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*pi-coding-agent*' }

foreach ($n in $nodes) {
    # First the pi process (node), then its parent cmd window.
    Stop-Process -Id $n.ProcessId -Force -ErrorAction SilentlyContinue
    try {
        $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($n.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($pp -and $pp.Name -eq 'cmd.exe') {
            Stop-Process -Id $pp.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        # parent already gone: ignore
    }
}

Start-Sleep -Milliseconds 400
