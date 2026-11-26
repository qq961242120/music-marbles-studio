#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' 2>/dev/null; then
  echo "请先安装 Node.js 22.12 或更新版本。" >&2
  exit 1
fi

venv_python=.venv/bin/python
if [[ ! -x "$venv_python" ]]; then
  candidates=(python3.12 python3.11 python3.10 python3.9 python3)
  if [[ -n "${PYTHON:-}" ]]; then candidates=("$PYTHON"); fi
  interpreter=
  for candidate in "${candidates[@]}"; do
    if "$candidate" -c 'import sys; sys.exit(not ((3, 9) <= sys.version_info[:2] <= (3, 12)))' 2>/dev/null; then
      interpreter="$candidate"
      break
    fi
  done
  if [[ -z "$interpreter" ]]; then
    echo "请安装 Python 3.9–3.12，或用 PYTHON 指定解释器路径。" >&2
    exit 1
  fi
  "$interpreter" -m venv .venv
fi

npm ci
# aubio 0.4.9 needs NumPy headers before building its extension.
"$venv_python" -m pip install --only-binary=numpy -c requirements.txt numpy 'setuptools<82' wheel
if [[ "$(uname -s)" == Darwin ]]; then
  export CFLAGS="${CFLAGS:-} -Wno-incompatible-function-pointer-types"
fi
"$venv_python" -m pip install --no-build-isolation -r requirements.txt
"$venv_python" -c 'import aubio, numpy'
echo "安装完成。运行 npm run dev，然后打开 http://127.0.0.1:7100"
