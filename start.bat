@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [H3Mise] 请先安装 Node.js 22.13 或更新版本，然后重新双击此文件。
  echo [H3Mise] Install Node.js 22.13 or newer, then double-click this file again.
  echo https://nodejs.org/
  start "" "https://nodejs.org/"
  pause
  popd
  exit /b 1
)
node scripts\launch.mjs %*
set "H3MISE_EXIT=%ERRORLEVEL%"
if not "%H3MISE_EXIT%"=="0" pause
popd
exit /b %H3MISE_EXIT%
