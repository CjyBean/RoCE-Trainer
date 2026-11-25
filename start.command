#!/bin/zsh
set -e
PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

if [[ -x "$PROJECT_DIR/.tools/node/bin/node" ]]; then
  export PATH="$PROJECT_DIR/.tools/node/bin:$PATH"
elif ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请安装 Node.js 22.12 或更高版本后重试。"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  npm install
fi

if [[ "$1" != "--no-browser" ]]; then
  (sleep 2; open "http://127.0.0.1:5173" >/dev/null 2>&1) &
fi

npm run dev
