@echo off
rem glyphcast station: relay + headless caster. Installed as a SYSTEM
rem scheduled task (onstart) by the Mac; absolute paths because SYSTEM has
rem no user PATH. The cast key lives only in .cast-key on this box.
cd /d C:\Users\orelo\srv\glyphcast
set PATH=%PATH%;C:\Users\orelo\AppData\Local\Microsoft\WinGet\Links
set /p GC_CAST_KEY=<.cast-key
set GC_DEFLATE=1
start "gc-relay" /b "C:\Users\orelo\AppData\Local\Microsoft\WinGet\Links\bun.exe" server\relay.ts
timeout /t 3 /nobreak >/dev/null
set GC_WS=ws://localhost:8788
set GC_CH=bbb
set GC_KEY=%GC_CAST_KEY%
set GC_COLS=160
set GC_MODE=quadrant
set GC_FPS=24
"C:\Users\orelo\AppData\Local\Microsoft\WinGet\Links\bun.exe" server\caster.ts
