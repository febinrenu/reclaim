@echo off
setlocal EnableDelayedExpansion
title Reclaim
cd /d "%~dp0"

echo ============================================================
echo   Reclaim - risk-aware revenue recovery engine
echo ============================================================
echo.

rem ── 0. Sanity: are we actually inside the project? ──────────────────────────
if not exist "package.json" (
    echo [ERROR] package.json was not found in:
    echo         %CD%
    echo.
    echo         start.bat must stay inside the reclaim project folder
    echo         ^(the same folder as package.json^). Move it back there
    echo         and run it again.
    goto :fail
)

rem "clean" wipes generated state (build cache, embedded db, dependency stamp)
rem for when something is stuck in a bad state and needs a fresh start.
if /i "%~1"=="clean" (
    echo [*] Clean requested: removing .next, .data, and the install stamp...
    if exist ".next" rmdir /s /q ".next" >nul 2>nul
    if exist ".data" rmdir /s /q ".data" >nul 2>nul
    if exist "node_modules\.install-stamp" del /q "node_modules\.install-stamp" >nul 2>nul
    echo [*] Done. Continuing with a normal start...
    echo.
)

rem ── 1. Node.js present? ──────────────────────────────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js was not found on PATH.
    call :try_install_node
    where node >nul 2>nul
    if errorlevel 1 (
        echo.
        echo [ERROR] Node.js is required and could not be installed automatically.
        echo         Install it yourself from https://nodejs.org
        echo         ^(the LTS version, 20.9 or newer^), then run start.bat again.
        goto :fail
    )
)

rem ── 2. Node.js new enough? ───────────────────────────────────────────────────
set "NODE_VER="
for /f "usebackq delims=" %%v in (`node -v`) do set "NODE_VER=%%v"
set "NODE_VER=%NODE_VER:v=%"
for /f "tokens=1 delims=." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 20 (
    echo [!] Node.js %NODE_VER% is older than the 20.9+ this project needs.
    echo     Trying anyway, but if something looks wrong, install a newer
    echo     Node.js from https://nodejs.org and run start.bat again.
    echo.
)

rem ── 3. npm present? ───────────────────────────────────────────────────────────
where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found even though node was. Your Node.js install
    echo         looks incomplete. Reinstall it from https://nodejs.org and
    echo         run start.bat again.
    goto :fail
)

rem ── 4. Dependencies installed and up to date? ────────────────────────────────
set "STAMP_FILE=node_modules\.install-stamp"
set "NEED_INSTALL=0"
if not exist "node_modules" set "NEED_INSTALL=1"
if not exist "%STAMP_FILE%" set "NEED_INSTALL=1"

if exist "package-lock.json" (
    for %%F in ("package-lock.json") do set "LOCK_STAMP=%%~tF"
    if exist "%STAMP_FILE%" (
        set /p SAVED_STAMP=<"%STAMP_FILE%"
        if not "!SAVED_STAMP!"=="!LOCK_STAMP!" set "NEED_INSTALL=1"
    )
)

if "!NEED_INSTALL!"=="1" (
    call :npm_install
    if errorlevel 1 goto :fail
    rem Stamped AFTER install, not before: npm rewrites package-lock.json's own
    rem mtime as a side effect even on a no-op install, so a pre-install stamp
    rem would never match on the next run and would reinstall every single
    rem time — a real bug, caught by actually running this twice in a row
    rem rather than assumed correct.
    if exist "package-lock.json" (
        for %%F in ("package-lock.json") do set "LOCK_STAMP=%%~tF"
        >"%STAMP_FILE%" echo !LOCK_STAMP!
    ) else (
        >"%STAMP_FILE%" echo installed
    )
) else (
    echo [*] Dependencies already installed and match package-lock.json.
)

rem ── 5. The embedded database's data directory exists? ───────────────────────
rem Defensive only — src/db/migrate.ts creates this itself — but it costs
rem nothing and closes a real historical bug (docs/INCIDENTS.md, D2: PGlite
rem failed on a missing parent directory) at the door regardless.
if not exist ".data" mkdir ".data" >nul 2>nul

rem ── 6. Credential mode, informational only — nothing here is required. ──────
echo.
if exist ".env" (
    echo [*] .env found — some ports may run against real services.
    echo     /api/health once running shows exactly which ones.
) else (
    echo [*] No .env found — running fully local. No credentials needed.
    echo     git clone, npm install, npm run dev is the whole setup story
    echo     ^(see README.md^); this script just automates and hardens it.
)
echo.

rem ── 7. Already running? Next.js 16 refuses a second dev server for the same ──
rem project even on a different port (verified directly: it exits 1 with a
rem clear message naming the existing PID and URL) — so check for that first
rem and point the user straight at the real answer, rather than let it surface
rem as a generic-looking crash below. The lock is self-cleaning even across a
rem hard kill (verified: force-killing the dev process removes .next\dev\lock
rem immediately, a Windows delete-on-close handle) — so if this file exists,
rem the PID inside it is genuinely still alive, not stale garbage. Checked
rem anyway with tasklist before trusting it, since "verified once" is not the
rem same guarantee as "true in every future Node/Next version."
set "LOCK_INFO="
set "EXISTING_URL="
set "EXISTING_PID="
if exist ".next\dev\lock" (
    for /f "usebackq delims=" %%u in (`node -e "try{const l=JSON.parse(require('fs').readFileSync('.next/dev/lock','utf8'));console.log((l.appUrl||'')+'|'+(l.pid||''))}catch(e){}" 2^>nul`) do set "LOCK_INFO=%%u"
)
if defined LOCK_INFO (
    for /f "tokens=1,2 delims=|" %%a in ("!LOCK_INFO!") do (
        set "EXISTING_URL=%%a"
        set "EXISTING_PID=%%b"
    )
)
if defined EXISTING_PID (
    tasklist /FI "PID eq !EXISTING_PID!" 2>nul | findstr /I "!EXISTING_PID!" >nul 2>nul
    if not errorlevel 1 (
        echo ============================================================
        echo   Reclaim is already running on this machine.
        echo ============================================================
        echo   Open it directly:   !EXISTING_URL!
        echo.
        echo   To stop that instance and start fresh here instead:
        echo     taskkill /PID !EXISTING_PID! /F
        echo   then run start.bat again.
        echo.
        pause
        exit /b 0
    )
)

rem ── 8. Launch. ─────────────────────────────────────────────────────────────
echo ============================================================
echo   Starting the dev server...
echo   If port 3000 is busy, Next.js will pick the next free one
echo   and print the real URL below. Press Ctrl+C to stop.
echo ============================================================
echo.

rem Best-effort: open the browser a few seconds in, once the server has had
rem a chance to come up. Detached, and every failure here is swallowed — this
rem is a convenience, never something the app's success depends on.
start "" /min cmd /c "timeout /t 6 >nul & start "" http://localhost:3000 >nul 2>nul"

call npm run dev
set "DEV_EXIT=%ERRORLEVEL%"

if not "%DEV_EXIT%"=="0" (
    echo.
    echo ============================================================
    echo   The dev server exited with an error ^(code %DEV_EXIT%^).
    echo ============================================================
    echo   This is usually one of:
    echo     - another process already using every port Next.js tried
    echo     - a corrupted .next build cache from an earlier interrupted run
    echo     - an actual code or configuration problem
    echo.
    echo   Try:  start.bat clean
    echo   That clears the build cache and local database, then starts fresh.
    echo   It does NOT touch your source code or .env.
    echo.
    goto :fail
)

goto :end

rem ══════════════════════════════════════════════════════════════════════════
:npm_install
echo [*] Installing dependencies ^(npm install^)... this can take a minute.
call npm install --no-audit --no-fund
if not errorlevel 1 exit /b 0

echo [!] npm install failed. Retrying once...
call npm install --no-audit --no-fund
if not errorlevel 1 exit /b 0

echo [!] Still failing. Clearing the npm cache and trying once more...
call npm cache clean --force >nul 2>nul
call npm install --no-audit --no-fund
if not errorlevel 1 exit /b 0

echo.
echo [ERROR] npm install failed three times in a row. This is almost always
echo         a network problem ^(no internet, a proxy, or a blocked registry^).
echo         Check your connection, then either run start.bat again or run
echo         "npm install" by hand to see the full error output.
exit /b 1

rem ══════════════════════════════════════════════════════════════════════════
:try_install_node
where winget >nul 2>nul
if errorlevel 1 (
    echo     winget is not available on this machine, so Node.js cannot be
    echo     installed automatically.
    exit /b 1
)
echo     Attempting to install Node.js LTS via winget...
echo     ^(This opens a normal winget install — approve any prompt it shows.^)
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
echo.
echo     If that just finished, close this window and run start.bat again —
echo     PATH changes from a fresh install often need a new window to take effect.
exit /b 0

rem ══════════════════════════════════════════════════════════════════════════
:fail
echo.
echo ------------------------------------------------------------
echo   start.bat could not finish. See the message above for why.
echo ------------------------------------------------------------
pause
exit /b 1

:end
echo.
echo Reclaim has stopped.
pause
exit /b 0
