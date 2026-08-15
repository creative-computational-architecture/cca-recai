@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo CCA-RECAI ilk kurulum yapiliyor...
  call npm install
  if errorlevel 1 goto :error
)
set RECAI_OPEN_BROWSER=1
call npm start
exit /b %errorlevel%

:error
echo Kurulum tamamlanamadi. Ustteki hata metnini kaydet.
pause
exit /b 1

