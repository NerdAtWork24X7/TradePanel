@echo off
rem Update TradePanel's generated OpenTrader checkout and reapply the extension packs.
rem The work is done by scripts/tradepanel.mjs (this is "scripts/tradepanel.mjs --update --setup").
rem
rem   update.cmd                re-assemble at the ref in opentrader.config.json
rem   update.cmd --ref main     another tag, branch or commit
rem   update.cmd --latest       the newest vX.Y.Z release tag
rem
rem Everything is passed to scripts/tradepanel.mjs; run "tradepanel --help" for all flags.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo update: Node.js 22 or newer is required ^(https://nodejs.org^).
  exit /b 1
)
node "%~dp0scripts\tradepanel.mjs" --update --setup %*
exit /b %ERRORLEVEL%
