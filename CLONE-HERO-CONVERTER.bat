@echo off
:: Step 1: Start the backend transcode worker in a new window
echo Starting backend transcode worker...
start "Backend Server" cmd /k "npm run start-backend"

:: Step 2: Open a second terminal, navigate to the frontend directory, and start Vite
echo Starting Vite React frontend...
start "Frontend Server" cmd /k "cd /d C:\clone-hero-converter && npm run start-frontend"

:: Step 3: Wait a moment for Vite to spin up, then launch the browser
:: Vite usually defaults to port 5173, but adjust this URL if your config uses a different port.
timeout /t 3 /nobreak >nul
echo Opening browser...
start http://localhost:6969