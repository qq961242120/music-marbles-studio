#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]] || ! .venv/bin/python -c 'import aubio, numpy' 2>/dev/null || ! node_modules/ffmpeg-static/ffmpeg -version >/dev/null 2>&1; then
  echo "正在准备本机依赖…"
  bash scripts/setup.sh
fi
exec npm run dev -- --host 127.0.0.1 --port 7100
