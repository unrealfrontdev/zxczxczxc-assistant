@echo off
setlocal EnableDelayedExpansion
:: ============================================================================
::  run-dev.bat — start AI Assistant in hot-reload development mode on Windows
::
::  Run setup.bat once before using this script.
::  Usage:
::      run-dev.bat              — start Tauri dev (Vite + Rust watch)
::      run-dev.bat --release    — one-shot release build
:: ============================================================================

title AI Assistant — Dev Launcher

for /f %%a in ('echo prompt $E ^| cmd') do set ESC=%%a
set GREEN=%ESC%[32m
set YELLOW=%ESC%[33m
set RED=%ESC%[31m
set CYAN=%ESC%[36m
set RESET=%ESC%[0m

:: Guard — must run from the ai-assistant directory
if not exist "package.json" (
    echo %RED%[error]%RESET% Run this script from inside the ai-assistant\ folder.
    pause >nul
    exit /b 1
)
if not exist "src-tauri\Cargo.toml" (
    echo %RED%[error]%RESET% src-tauri\Cargo.toml not found.
    pause >nul
    exit /b 1
)

:: Ensure cargo is on PATH (handles freshly-installed Rust in same session)
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set PATH=%USERPROFILE%\.cargo\bin;%PATH%
)

:: Quick sanity checks
where cargo >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo %RED%[error]%RESET% cargo not found. Run setup.bat first.
    pause >nul
    exit /b 1
)
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo %RED%[error]%RESET% npm not found. Run setup.bat first.
    pause >nul
    exit /b 1
)

:: Ensure dist\ exists (cargo build will fail without it)
if not exist "dist" (
    mkdir dist
    echo. > dist\.gitkeep
)

:: ── Parse arguments ───────────────────────────────────────────────────────
set MODE=dev
if /i "%~1"=="--release" set MODE=release
if /i "%~1"=="-r"        set MODE=release
if /i "%~1"=="--build"   set MODE=release

echo.
echo %CYAN%══════════════════════════════════════════════════════%RESET%
if "%MODE%"=="release" (
    echo %CYAN%   AI Assistant — Release Build%RESET%
) else (
    echo %CYAN%   AI Assistant — Dev Mode%RESET%
)
echo %CYAN%══════════════════════════════════════════════════════%RESET%
echo.

if "%MODE%"=="release" (
    echo %GREEN%[build]%RESET% Running: npm run tauri build
    echo.
    call npm run tauri build
    if %ERRORLEVEL% neq 0 (
        echo %RED%[error]%RESET% Build failed. See output above.
        pause >nul
        exit /b 1
    )
    echo.
    echo %GREEN%Build complete.%RESET%
    echo Installer / bundle: src-tauri\target\release\bundle\
    start "" "src-tauri\target\release\bundle"
) else (
    echo %GREEN%[dev]%RESET% Running: npm run tauri dev
    echo %YELLOW%      (Ctrl+C to stop)%RESET%
    echo.
    call npm run tauri dev
)

endlocal
