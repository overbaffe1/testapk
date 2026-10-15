@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -RepoRoot "%CD%"
if errorlevel 1 (
  echo.
  echo Установка завершилась с ошибкой.
  pause
  exit /b 1
)
echo.
echo qWDTT установлен для текущего пользователя без прав администратора.
echo Полностью закройте и снова откройте Chrome.
pause
