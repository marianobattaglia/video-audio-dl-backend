@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0descargar_windows.ps1"
if errorlevel 1 (
  echo.
  echo El script termino con un error. Revisa el mensaje anterior.
  pause
)
endlocal
