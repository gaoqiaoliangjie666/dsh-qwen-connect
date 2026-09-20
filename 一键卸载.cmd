@echo off
REM ============================================================================
REM  dsh-qwen-connect  one-click uninstall  (Windows)
REM
REM  Removes the three profile registrations and the junction.
REM  Does NOT delete the plugin source folder, and leaves the dependency bridge
REM  alone (other plugins may share it).
REM
REM  Usage: double-click, optionally with --profile "<dir>".
REM
REM  NOTE: keep this file ASCII-only (see 一键安装.cmd for the reason).
REM ============================================================================
setlocal enabledelayedexpansion
set "HERE=%~dp0"
cd /d "%HERE%"

echo.
echo ============================================================
echo   dsh-qwen-connect - uninstall
echo ============================================================
echo.

REM  Avoid `for /f ... in ('command')` - see 一键安装.cmd for why.
set "NODE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "%HERE%node\node.exe" set "NODE=%HERE%node\node.exe"
if not defined NODE (
  where node >nul 2>&1
  if !errorlevel! equ 0 set "NODE=node"
)

if not defined NODE (
  echo ERROR: Node.js not found, cannot uninstall.
  echo.
  echo   Manual steps:
  echo     1. delete  ^<profile^>\node_modules\dsh-qwen-connect
  echo     2. remove the dsh-qwen-connect entries from
  echo        dependencies / dsh.profile.bundles / pnpm.overrides
  echo        inside ^<profile^>\package.json
  echo.
  pause
  exit /b 1
)

echo using Node: %NODE%
echo.
"%NODE%" "%HERE%tools\install-to-dsh.mjs" --uninstall %*
set "RC=!errorlevel!"
echo.
if !RC! equ 0 (
  echo OK - uninstalled. Restart DSH to take effect.
) else (
  echo FAILED - exit code !RC!
)
echo.
pause
exit /b !RC!
