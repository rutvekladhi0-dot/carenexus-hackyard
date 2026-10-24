@echo off
setlocal
cd /d "%~dp0"
title CareNexus - Local Server

echo ========================================
echo        CareNexus Local Launcher
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not in PATH.
  echo Install the LTS version from the official Node.js website, then reopen this file.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo First-time setup: installing required packages...
  call npm install
  if errorlevel 1 (
    echo.
    echo Package installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo.
echo Starting CareNexus...
echo When the server is ready, open http://localhost:3000 in your browser.
echo Keep this window open while using CareNexus.
echo Press Ctrl+C in this window to stop the server.
echo.
call npm start
pause
