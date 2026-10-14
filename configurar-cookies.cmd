@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   Configurar cookies do YouTube na Vercel
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0configurar-cookies.ps1"
echo.
echo ------------------------------------------------------------
pause
