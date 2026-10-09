@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0\..\.."
docker info >nul 2>&1
if errorlevel 1 (
  echo 请先安装并启动 Docker Desktop，使用 Linux 容器模式。
  echo 官方下载：https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo 请填写 AUTH_PASSWORD：至少 16 位；可同时填写 AI_API_KEY。
  echo 配置只保存在本机，不要上传或分享 .env 文件。
  notepad .env
  echo 保存并关闭记事本后，按任意键继续。
  pause >nul
)
docker compose up --build -d
if errorlevel 1 (
  echo 启动失败。请检查 .env 中的 AUTH_USER 和 AUTH_PASSWORD。
  pause
  exit /b 1
)
echo 服务已启动；首次构建可能需要几分钟。
echo 登录用户名和密码是 .env 中的 AUTH_USER 和 AUTH_PASSWORD。
start "" http://localhost:3000
pause
