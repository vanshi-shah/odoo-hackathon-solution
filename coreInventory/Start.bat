@echo off
title CoreInventory
cd /d "%~dp0"

echo.
echo  ==============================
echo    CoreInventory - Starting...
echo  ==============================
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
  echo  Installing dependencies, please wait...
  echo  (This only happens once)
  echo.
  npm install
  echo.
)

:: Open browser after 2 second delay (server needs to start first)
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000/login.html"

:: Start the server (keep this window open)
echo  Server starting at http://localhost:3000
echo  Browser will open automatically...
echo  Close this window to STOP the server.
echo.
node server/index.js
