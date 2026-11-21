@echo off
rem TradePanel: set the workspace up and run the app. The work is done by tradepanel.mjs.
rem
rem   tradepanel.cmd                set up if needed, then start the desktop app
rem   tradepanel.cmd --setup        set up only, do not start
rem   tradepanel.cmd -- --no-watch  arguments after -- go to "tauri dev"
rem
rem Everything is passed to tradepanel.mjs; run "tradepanel.mjs --help" for all flags.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo tradepanel: Node.js 22 or newer is required ^(https://nodejs.org^).
  exit /b 1
)
node "%~dp0tradepanel.mjs" %*
exit /b %ERRORLEVEL%
