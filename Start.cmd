@echo off
cd /d "%~dp0"
if not exist ".runtime\python.exe" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1"
  if errorlevel 1 goto failed
)
".runtime\python.exe" -c "import flask, waitress, faster_whisper, whisper_local; from importlib.metadata import version; version('pyannote.audio')" >nul 2>nul
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup.ps1"
  if errorlevel 1 goto failed
)
".runtime\python.exe" -m whisper_local %*
if errorlevel 1 goto failed
exit /b 0
:failed
echo.
echo The app could not start. See the message above.
pause
exit /b 1
