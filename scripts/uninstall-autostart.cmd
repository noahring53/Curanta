@echo off
REM Removes Curanta auto-start (deletes the Startup shortcut). Does NOT touch your
REM data, drafts, or settings, and does not stop an already-running server — end
REM node.exe in Task Manager for that, or just let it exit on your next shutdown.
set DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Curanta.vbs
if exist "%DST%" (
  del /F "%DST%"
  echo Removed. Curanta will no longer start automatically. Run it manually any time with: npm start
) else (
  echo Nothing to remove — auto-start was not installed.
)
