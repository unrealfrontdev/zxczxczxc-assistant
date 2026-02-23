@echo off
setlocal EnableDelayedExpansion
:: ============================================================================
::  setup.bat — bootstrap the full dev environment for ai-assistant on Windows
::
::  Requirements satisfied automatically (where possible):
::    - Rust (stable, MSVC toolchain)
::    - Node.js 18+  / npm
::    - WebView2 Runtime  (bundled with Win10 1903+, auto-installed otherwise)
::    - Visual C++ Build Tools (required by the Rust MSVC toolchain)
::
::  Run once from a regular (non-admin) PowerShell/CMD terminal:
::      cd ai-assistant
::      setup.bat
::  Then launch the app in dev mode:
::      run-dev.bat
::  Or build a release bundle:
::      npm run tauri build
:: ============================================================================

title AI Assistant — Windows Setup

:: Pretty colour codes (ANSI — works in Windows 10 1607+ and Windows Terminal)
for /f %%a in ('echo prompt $E ^| cmd') do set ESC=%%a
set GREEN=%ESC%[32m
set YELLOW=%ESC%[33m
set RED=%ESC%[31m
set CYAN=%ESC%[36m
set RESET=%ESC%[0m

goto :MAIN

::──────────────────────────────────────────────────────────────────────────────
:info
  echo %GREEN%[setup]%RESET% %~1
  goto :EOF

:warn
  echo %YELLOW%[warn]%RESET% %~1
  goto :EOF

:error
  echo %RED%[error]%RESET% %~1
  echo.
  echo Press any key to exit …
  pause >nul
  exit /b 1

::──────────────────────────────────────────────────────────────────────────────
:MAIN

echo.
echo %CYAN%══════════════════════════════════════════════════════%RESET%
echo %CYAN%   AI Assistant — Windows Setup                       %RESET%
echo %CYAN%══════════════════════════════════════════════════════%RESET%
echo.

:: Guard — must run from inside the ai-assistant directory
if not exist "package.json" (
    call :error "Run this script from inside the ai-assistant\ folder."
)
if not exist "src-tauri\Cargo.toml" (
    call :error "src-tauri\Cargo.toml not found. Repo may be incomplete."
)

:: ── 1. Visual C++ Build Tools ─────────────────────────────────────────────
echo.
call :info "Step 1: Checking Visual C++ Build Tools …"
:: cl.exe is the MSVC C compiler — if it is in PATH, build tools are present.
where cl.exe >nul 2>&1
if %ERRORLEVEL% neq 0 (
    call :warn "MSVC cl.exe not found in PATH."
    call :warn "The Rust MSVC toolchain requires Visual C++ Build Tools."
    call :warn ""
    call :warn "Option A — Install Visual Studio 2022 (Community, free):"
    call :warn "  https://aka.ms/vs/17/release/vs_BuildTools.exe"
    call :warn "  Select workload: 'Desktop development with C++'"
    call :warn ""
    call :warn "Option B — Install Build Tools only (smaller):"
    call :warn "  winget install Microsoft.VisualStudio.2022.BuildTools"
    call :warn ""
    call :warn "After installing, re-run this script from a"
    call :warn "'Developer Command Prompt for VS 2022' or a new terminal."
    echo.
    :: We continue anyway — rustup will warn at compile time if needed.
)

:: ── 2. Rust ───────────────────────────────────────────────────────────────
echo.
call :info "Step 2: Checking Rust …"
where cargo >nul 2>&1
if %ERRORLEVEL% neq 0 (
    call :warn "cargo not found. Installing Rust via rustup …"
    :: Download rustup-init.exe silently
    set RUSTUP_INIT=%TEMP%\rustup-init.exe
    echo Downloading rustup-init.exe …
    powershell -NoProfile -Command ^
        "Invoke-WebRequest -Uri 'https://win.rustup.rs/x86_64' -OutFile '%TEMP%\rustup-init.exe' -UseBasicParsing"
    if %ERRORLEVEL% neq 0 (
        call :error "Failed to download rustup-init.exe. Check your internet connection."
    )
    :: Install silently: stable toolchain, MSVC host, no PATH modification dialog
    "%TEMP%\rustup-init.exe" -y --default-toolchain stable --default-host x86_64-pc-windows-msvc
    if %ERRORLEVEL% neq 0 (
        call :error "rustup-init failed. See output above."
    )
    :: Add cargo bin to PATH for the rest of this session
    set PATH=%USERPROFILE%\.cargo\bin;%PATH%
    del /f /q "%TEMP%\rustup-init.exe" >nul 2>&1
    call :info "Rust installed successfully."
) else (
    for /f "tokens=*" %%v in ('rustc --version 2^>nul') do call :info "Rust: %%v"
)

:: Ensure stable toolchain is active
call :info "Ensuring stable toolchain …"
rustup default stable >nul 2>&1

:: ── 3. Node.js ────────────────────────────────────────────────────────────
echo.
call :info "Step 3: Checking Node.js …"
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    call :warn "node not found. Attempting install via winget …"
    winget install --id OpenJS.NodeJS.LTS --source winget --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        call :warn "winget install failed. Please install Node.js 18+ manually:"
        call :warn "  https://nodejs.org/en/download"
        call :error "Node.js is required. Aborting."
    )
    :: Refresh PATH
    for /f "tokens=*" %%p in ('powershell -NoProfile -Command "[System.Environment]::GetEnvironmentVariable(\"Path\",\"Machine\") + \";\" + [System.Environment]::GetEnvironmentVariable(\"Path\",\"User\")"') do set PATH=%%p
    call :info "Node.js installed via winget."
)
for /f "tokens=*" %%v in ('node --version 2^>nul') do call :info "Node.js: %%v"

where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    call :error "npm not found even after Node.js install. Aborting."
)

:: ── 4. WebView2 Runtime ───────────────────────────────────────────────────
echo.
call :info "Step 4: Checking Microsoft Edge WebView2 Runtime …"
:: WebView2 is bundled with Windows 10 20H2+ (version 1902+).
:: Check via registry; key presence means it is installed.
set WV2_KEY="HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
reg query %WV2_KEY% >nul 2>&1
if %ERRORLEVEL% neq 0 (
    call :warn "WebView2 Runtime not found. Downloading Evergreen bootstrapper …"
    set WV2_BOOTSTRAP=%TEMP%\MicrosoftEdgeWebview2Setup.exe
    powershell -NoProfile -Command ^
        "Invoke-WebRequest -Uri 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile '%TEMP%\MicrosoftEdgeWebview2Setup.exe' -UseBasicParsing"
    if %ERRORLEVEL% neq 0 (
        call :warn "Failed to download WebView2 bootstrapper."
        call :warn "Install it manually: https://go.microsoft.com/fwlink/p/?LinkId=2124703"
    ) else (
        "%TEMP%\MicrosoftEdgeWebview2Setup.exe" /silent /install
        del /f /q "%TEMP%\MicrosoftEdgeWebview2Setup.exe" >nul 2>&1
        call :info "WebView2 Runtime installed."
    )
) else (
    call :info "WebView2 Runtime is present."
)

:: ── 5. Node deps ──────────────────────────────────────────────────────────
echo.
call :info "Step 5: Installing Node.js dependencies …"
call npm install
if %ERRORLEVEL% neq 0 (
    call :error "npm install failed. See output above."
)

:: ── 6. dist/ placeholder ──────────────────────────────────────────────────
echo.
call :info "Step 6: Ensuring dist\ placeholder exists …"
if not exist "dist" (
    mkdir dist
    echo. > dist\.gitkeep
    call :info "Created dist\ placeholder (required by tauri::generate_context!)"
) else (
    call :info "dist\ already exists — skipping."
)

:: ── 7. Cargo check ────────────────────────────────────────────────────────
echo.
call :info "Step 7: Running cargo check to verify Rust build …"
cd src-tauri
cargo check 2>&1
if %ERRORLEVEL% neq 0 (
    cd ..
    call :error "'cargo check' failed. See output above."
)
cd ..
call :info "Rust build check passed."

:: ── Done ──────────────────────────────────────────────────────────────────
echo.
echo %CYAN%══════════════════════════════════════════════════════%RESET%
echo %GREEN%   Setup complete!%RESET%
echo %CYAN%══════════════════════════════════════════════════════%RESET%
echo.
echo   Next steps:
echo.
echo   %CYAN%Dev mode  (hot-reload):%RESET%
echo     run-dev.bat
echo     — or —
echo     npm run tauri dev
echo.
echo   %CYAN%Release build:%RESET%
echo     npm run tauri build
echo     Output: src-tauri\target\release\bundle\
echo.
echo   %CYAN%Hotkeys:%RESET%
echo     Alt+M          toggle click-through (ghost mode)
echo     Alt+Shift+S    capture screen and analyse
echo     Alt+Shift+H    hide / show overlay
echo.
pause
endlocal
