#!/bin/zsh
set -euo pipefail

export PATH="/Users/xushaokan/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY

PROJECT_DIR="/Users/xushaokan/astro-paper-blog"
NAS_DIR="/Volumes/文件/opentrend/projects"
NAS_SMB_URL="smb://192.168.1.215/%E6%96%87%E4%BB%B6"
LOG_DIR="$PROJECT_DIR/logs"
LOCK_DIR="/tmp/opentrend-daily.lock"

mkdir -p "$LOG_DIR"

exec >> "$LOG_DIR/opentrend-daily.log" 2>&1

echo "============================================================"
echo "OpenTrend daily job started at $(date '+%Y-%m-%d %H:%M:%S')"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another OpenTrend daily job is already running. Exit."
  exit 0
fi

cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT

if [ ! -d "$NAS_DIR" ]; then
  echo "NAS directory is not mounted. Trying to mount via osascript..."
  osascript -e 'mount volume "smb://192.168.1.215/文件"' 2>/dev/null || open "$NAS_SMB_URL" || true
  for _ in {1..30}; do
    if [ -d "$NAS_DIR" ]; then
      break
    fi
    sleep 2
  done
fi

if [ ! -d "$NAS_DIR" ]; then
  echo "NAS directory still unavailable: $NAS_DIR"
  exit 1
fi

cd "$PROJECT_DIR"

export TREND_NAS_DIR="$NAS_DIR"
export TREND_NAS_PUBLIC_BASE_URL="https://files.qiyuebao.xyz/opentrend/projects"
export TREND_NAS_RETENTION_DAYS="30"
export TREND_NAS_MAX_PROJECTS="20"

echo "Step 1/4: fetch and generate trend report"
pnpm trends:run

echo "Step 2/4: sync archives to NAS"
pnpm trends:nas

echo "Step 3/4: build site"
pnpm build

echo "Step 4/4: deploy to Vercel"
pnpm --config.proxy= --config.https-proxy= dlx vercel --prod --yes

echo "OpenTrend daily job finished at $(date '+%Y-%m-%d %H:%M:%S')"
