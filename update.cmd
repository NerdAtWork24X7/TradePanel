@echo off
rem Update TradePanel's generated OpenTrader checkout and reapply the extension packs.
rem
rem   update.cmd                     newest upstream release tag
rem   update.cmd --ref main          upstream HEAD
rem   update.cmd --check             assemble, typecheck and run the tests
rem   update.cmd --without analyst   assemble without one pack
rem   update.cmd --locked            reproduce opentrader.lock.json
rem
rem Everything is passed to scripts\update-opentrader.mjs; run "update.cmd --help" for all flags.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo update: Node.js 22 or newer is required ^(https://nodejs.org^).
  exit /b 1
)
node "%~dp0scripts\update-opentrader.mjs" %*
