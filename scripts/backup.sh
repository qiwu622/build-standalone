#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -ne 1 ]; then echo '用法：bash scripts/backup.sh 新的备份目录' >&2; exit 1; fi
destination="$(realpath -m -- "$1")"
cd -- "$project_root"
node scripts/control.mjs stop
data_path="$(node --input-type=module -e 'import {loadConfig} from "./src/storage.mjs"; console.log((await loadConfig()).dataDir)')"
case "$destination" in "$data_path"|"$data_path/"*) echo '备份不能放在数据目录内' >&2; exit 1;; esac
if [ -e "$destination" ]; then echo '备份目标已存在，不覆盖' >&2; exit 1; fi
umask 077
mkdir -p -- "$destination"
cp -a -- "$data_path" "$destination/data"
if [ -f config.json ]; then cp -- config.json "$destination/"; fi
echo "私有备份完成：$destination。包含密钥和登录资料，请勿放进发布包。"
