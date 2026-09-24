@echo off
REM ============================================================================
REM  dsh-qwen-connect  one-click install  (Windows)
REM
REM  Just double-click this file. It will:
REM    1. locate a usable Node.js (bundled / PATH / common install paths)
REM    2. auto-detect every DSH profile on this machine
REM       (Desktop / CLI / custom DSH_HOME)
REM    3. inject the plugin into the selected profile
REM
REM  Optional arguments:
REM    --profile "<dir>"   install into a specific profile
REM    --dry-run           preview only, write nothing
REM    --uninstall         remove the wiring
REM
REM  Why .cmd instead of .ps1: PowerShell execution policy blocks double-clicking
REM  .ps1 on default Windows, while .cmd always runs.
REM
REM  NOTE: keep this file ASCII-only. cmd.exe parses non-ASCII text and
REM  parentheses inside echo/if blocks in the OEM codepage; mixing them in
REM  caused "'xxx' is not recognized as an internal or external command".
REM ============================================================================
setlocal enabledelayedexpansion
set "HERE=%~dp0"
cd /d "%HERE%"

echo.
echo ============================================================
echo   dsh-qwen-connect - one-click install
echo ============================================================
echo.

REM ---- 1) locate Node.js -----------------------------------------------------
REM  Avoid `for /f ... in ('command')`: capturing a child process's stdout is
REM  blocked in some sandboxed shells (silent exit, no error). Plain existence
REM  checks + `where` (used only for its exit code) are enough.
set "NODE="
if exist "%HERE%node\node.exe" (
  set "NODE=%HERE%node\node.exe"
  echo [1/3] using bundled Node.js
) else (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
  if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
  if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
  if defined NODE echo [1/3] using Node.js from a common install path
  if not defined NODE (
    where node >nul 2>&1
    if !errorlevel! equ 0 (
      REM `where node` succeeded: let the shell resolve "node" itself.
      set "NODE=node"
      echo [1/3] using Node.js from PATH
    )
  )
)

if not defined NODE (
  echo [1/3] ERROR: Node.js not found
  echo.
  echo   Please install Node.js 22.19+ or 24+ from https://nodejs.org/
  echo   Or drop a portable node.exe into a "node" subfolder next to this file.
  echo.
  pause
  exit /b 1
)

"%NODE%" --version >nul 2>&1
if !errorlevel! neq 0 (
  echo [1/3] ERROR: Node.js cannot run: %NODE%
  pause
  exit /b 1
)
echo         node = %NODE%
echo.

REM ---- 2) inject -------------------------------------------------------------
if not exist "%HERE%tools\install-to-dsh.mjs" (
  echo [2/3] ERROR: missing tools\install-to-dsh.mjs
  echo         Keep this file inside the unpacked plugin folder.
  pause
  exit /b 1
)

echo [2/3] injecting into DSH ...
echo.
"%NODE%" "%HERE%tools\install-to-dsh.mjs" %*
set "RC=!errorlevel!"
echo.

if !RC! neq 0 (
  echo ============================================================
  echo   FAILED  exit code !RC!
  echo ============================================================
  echo.
  echo   Common causes:
  echo     - DSH is not installed, or has never been started once
  echo     - insufficient permissions - try "Run as administrator"
  echo     - several DSH profiles exist and the wrong one was picked
  echo       - pass --profile "dir" to choose explicitly
  echo.
  pause
  exit /b !RC!
)

REM ---- 3) done ---------------------------------------------------------------
echo [3/3] done
echo.
echo ============================================================
echo   OK - installed successfully
echo ============================================================
echo.
echo   Next steps:
echo     1. Quit DSH completely - including the tray icon
echo     2. Start DSH again
echo     3. Open Settings - Plugins; you should see "QwenWork Connect"
echo.
echo   Requirement: the QwenWork (Qianwen Office) desktop app must already be
echo   installed and signed in on this machine.
echo.
pause
