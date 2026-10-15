@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\.."
echo.
echo qWDTT - установка компонента для Chrome
echo.
echo 1. Откройте chrome://extensions
 echo 2. Найдите qWDTT и скопируйте его ID (32 буквы)
echo.
set /p EXTENSION_ID=Вставьте ID расширения: 
if "%EXTENSION_ID%"=="" (
  echo ID не введён.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -ExtensionId "%EXTENSION_ID%" -RepoRoot "%CD%"
if errorlevel 1 (
  echo.
  echo Установка завершилась с ошибкой.
  pause
  exit /b 1
)
echo.
echo Готово. Полностью закройте и снова откройте Chrome.
pause
