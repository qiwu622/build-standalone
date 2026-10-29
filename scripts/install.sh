#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_root"
skip_browser=false
skip_tests=false
for argument in "$@"; do
  case "$argument" in
    --skip-browser) skip_browser=true ;;
    --skip-tests) skip_tests=true ;;
    *) echo "未知参数: $argument" >&2; exit 1 ;;
  esac
done
command -v node >/dev/null || { echo '需要 Node.js 22+（推荐 24 LTS）和 npm' >&2; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || { echo '需要 Node.js 22+' >&2; exit 1; }
if [ "$(id -u)" = '0' ]; then echo '请使用独立的非 root 用户安装和运行；浏览器保留 sandbox。' >&2; exit 1; fi
umask 077
mkdir -p -- work/tmp
export TMPDIR="$project_root/work/tmp" TEMP="$project_root/work/tmp" TMP="$project_root/work/tmp"
export npm_config_cache="$project_root/work/npm-cache"
if [ ! -f config.json ]; then cp -- config.example.json config.json; fi
npm ci --ignore-scripts --no-audit --no-fund
node src/main.mjs --init
data_path="$(node --input-type=module -e 'import {loadConfig} from "./src/storage.mjs"; console.log((await loadConfig()).dataDir)')"
chmod 700 -- "$data_path"
if [ "$skip_tests" = false ]; then npm test; fi
if [ "$skip_browser" = false ]; then npm run install:browser; fi
echo '安装完成：npm start 或 npm run start:background；停止：npm stop'
echo 'Linux 浏览器系统库安装、SSH X11 登录和常驻运行见 docs/linux.md。'
