@echo off
setlocal
rem One launcher and one runtime. Optional -Universe or -ChooseUniverse only.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-SpeXGSP.ps1" %*
exit /b %errorlevel%
