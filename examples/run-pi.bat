@echo off
REM === run-pi.bat — example launcher for pi (double-clickable) ===
REM - kills any existing pi instance (process + window) before starting,
REM   so re-running this script never leaves ghost windows behind;
REM - no trailing "pause": the window closes by itself when pi exits.
REM
REM Customize: set your working dir and model below.

REM Kill previous pi instances (needs kill-pi.ps1 next to this bat).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0kill-pi.ps1"

cd /d "C:\path\to\your\working\dir"
pi --model "provider/model-id"

REM Keep the window open only on startup errors, for debugging.
if errorlevel 1 (
  echo.
  echo [run pi] pi exited with an error - window stays open for debugging
  pause
)
