' Launches the Curanta server with NO visible console window (window style 0).
' The scheduled task "Curanta Auto-Draft" runs this at logon so the server is
' always up — which is what lets Auto-Draft check sources hourly and email you.
CreateObject("WScript.Shell").Run "C:\Users\noahr\Git\letterwriterai\scripts\run-curanta.cmd", 0, False
