@echo off
REM Makes Curanta start automatically at logon by dropping its hidden launcher
REM into your Startup folder. No admin rights needed, nothing system-wide changes.
REM Re-run any time; it just overwrites the shortcut.
setlocal
set SRC=C:\Users\noahr\Git\letterwriterai\scripts\start-curanta.vbs
set DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Curanta.vbs
copy /Y "%SRC%" "%DST%" >nul
if %ERRORLEVEL%==0 (
  echo Installed. Curanta will start automatically the next time you log in.
  echo To start it right now without logging out, double-click:
  echo   %SRC%
  echo To remove auto-start later, run:  scripts\uninstall-autostart.cmd
) else (
  echo Could not copy to the Startup folder. Check the path and try again.
)
endlocal
