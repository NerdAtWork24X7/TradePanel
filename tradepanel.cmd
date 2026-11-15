@echo off
rem TradePanel launcher for Windows (cmd.exe or PowerShell). The work is done by scripts\tradepanel.mjs.
rem
rem   tradepanel.cmd                     start the app (installs missing frontend dependencies)
rem   tradepanel.cmd --no-install        never install; report what is missing instead
rem   tradepanel.cmd -- --no-watch       arguments after -- go to "tauri dev"
setlocal

where node >nul 2>nul
if errorlevel 1 (
  echo tradepanel: Node.js 22+ is required: https://nodejs.org 1>&2
  exit /b 1
)

node "%~dp0scripts\tradepanel.mjs" %*
exit /b %ERRORLEVEL%
