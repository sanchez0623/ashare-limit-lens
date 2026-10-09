@echo off
chcp 65001 >nul
cd /d "%~dp0\..\.."
docker compose stop
echo 已停止自动模拟交易，持仓与账本保留在本机数据卷。
pause
