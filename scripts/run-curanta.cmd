@echo off
REM Runs the Curanta server and keeps it up: if node ever exits (crash, or the
REM machine wakes and it lost its port), it restarts after a short backoff. Called
REM hidden by start-curanta.vbs, which the Startup folder launches at logon.
REM Logs to data\service.log. Stop it from Task Manager (node.exe) or by deleting
REM the Startup shortcut (scripts\uninstall-autostart.cmd) and ending node.
cd /d "C:\Users\noahr\Git\letterwriterai"
if not exist data mkdir data
:loop
echo [%date% %time%] starting Curanta server >> "data\service.log"
"C:\Program Files\nodejs\node.exe" server.mjs >> "data\service.log" 2>&1
echo [%date% %time%] server exited, restarting in 10s >> "data\service.log"
timeout /t 10 /nobreak >nul
goto loop
