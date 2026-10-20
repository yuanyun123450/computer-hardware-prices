@echo off
cd /d "%~dp0"
setlocal
set "NODE=%PRICE_NODE%"
if not defined NODE for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if not defined NODE goto NONODE
echo Node: %NODE%
"%NODE%" -e "const v=process.versions.node.split('.').map(Number);if(v[0]<22||(v[0]===22&&v[1]<5)){console.error('need Node 22.5+');process.exit(1)}"
if errorlevel 1 goto OLDNODE
echo 服务地址: http://127.0.0.1:8787
start "" http://127.0.0.1:8787
"%NODE%" src\serve.mjs
pause
exit /b 0
:NONODE
echo [错误] 找不到 Node.js，请安装 Node 22.5+ 或设置环境变量 PRICE_NODE
pause
exit /b 1
:OLDNODE
echo [错误] Node 版本过低，需要 22.5 或更高（用到内置 node:sqlite）
pause
exit /b 1