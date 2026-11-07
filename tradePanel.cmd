@echo off
rem TradePanel launcher for native Windows (cmd.exe / PowerShell).
rem
rem   tradePanel.cmd                     launch (installs missing tools with consent)
rem   tradePanel.cmd -Yes                install missing tools without prompting
rem   tradePanel.cmd -NoInstall          never install; print instructions instead
rem   tradePanel.cmd --rebuild-backend   force a fresh Python sidecar first
rem
rem All arguments are forwarded to backend\scripts\bootstrap-windows.ps1.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backend\scripts\bootstrap-windows.ps1" %*
exit /b %ERRORLEVEL%
