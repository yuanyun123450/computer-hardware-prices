@echo off
cd /d "%~dp0"
echo 正在用京东公开报价接口刷新价格（无需登录）
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-jd.ps1"
echo.
pause