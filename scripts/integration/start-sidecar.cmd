@echo off
setlocal EnableExtensions DisableDelayedExpansion
if not exist "%~dp0bin\jarvis.exe" (
  echo Sidecar not found in "%~dp0bin".
  exit /b 1
)
set "USERPROFILE=%~dp0profile"
if /I "%~1"=="--check" (
  "%~dp0bin\jarvis.exe" --version
  exit /b
)
if not exist "%USERPROFILE%" mkdir "%USERPROFILE%"
if exist "%USERPROFILE%\.jarvis\sidecar.yaml" (
  start "" /D "%~dp0bin" "%~dp0bin\jarvis.exe"
  exit /b
)
set "jarvisLocalToken="
set /p "jarvisLocalToken=Paste the enrollment token: "
if not defined jarvisLocalToken (
  echo No token entered. Nothing started.
  exit /b 1
)
setlocal EnableDelayedExpansion
start "" /D "%~dp0bin" "%~dp0bin\jarvis.exe" --token "!jarvisLocalToken!"
