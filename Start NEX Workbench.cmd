@echo off
REM Windows: double-click to start NEX Workbench (installs and builds the first time).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS from https://nodejs.org, then run this again. & pause & exit /b 1)
node scripts\launch.mjs
pause
