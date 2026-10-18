@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
if exist node_modules goto run
echo Installing dependencies - first run only...
call npm install --no-audit --no-fund
if errorlevel 1 (echo npm install failed. & pause & exit /b 1)
:run
echo.
echo Starting Shipback SFTP at http://127.0.0.1:4646 - close this window to stop
echo.
node src\server.js
pause
