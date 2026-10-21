@echo off
:: Run from the folder this file is in, wherever that is (the new windows
:: inherit it), so the shortcut never starts an old copy of the app.
cd /d "%~dp0"

:: Step 1: Start the backend transcode worker in a new window
echo Starting backend transcode worker...
start "Backend Server" cmd /k "npm run start-backend"

:: Step 2: Open a second terminal in this folder (wherever it is) and start Vite
echo Starting Vite React frontend...
start "Frontend Server" cmd /k "npm run start-frontend"

:: Step 3: Wait a moment for Vite to spin up, then launch the browser
timeout /t 3 /nobreak >nul
echo Opening browser...
start http://localhost:6969