#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$#" -lt 1 ]; then echo '用法：bash scripts/upgrade.sh 解压后的新版本目录 [--skip-browser]' >&2; exit 1; fi
release_root="$(cd -- "$1" && pwd)"
shift
if [ "${1:-}" = '--target' ]; then
  if [ "$#" -lt 2 ]; then echo '--target 缺少旧安装目录' >&2; exit 1; fi
  project_root="$(cd -- "$2" && pwd)"
  shift 2
fi
if [ "$release_root" = "$project_root" ]; then echo '新版本必须先解压到另一目录' >&2; exit 1; fi
case "$release_root/" in "$project_root/"*) echo '新旧目录不能相互嵌套' >&2; exit 1;; esac
case "$project_root/" in "$release_root/"*) echo '新旧目录不能相互嵌套' >&2; exit 1;; esac
node --input-type=module -e 'import fs from "node:fs";if(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).name!=="build-standalone")process.exit(1)' "$release_root/package.json"
node --input-type=module -e 'import fs from "node:fs";if(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).name!=="build-standalone")process.exit(1)' "$project_root/package.json"
cd -- "$project_root"
node scripts/control.mjs stop
umask 077
backup_root="$project_root/work/upgrade-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p -- "$backup_root"
allowed=(src public scripts tests extensions docs licenses package.json package-lock.json config.example.json README.md CHANGELOG.md LICENSE THIRD_PARTY_NOTICES.md .gitignore)
for name in "${allowed[@]}"; do
  if [ -e "$project_root/$name" ]; then cp -a -- "$project_root/$name" "$backup_root/"; fi
done
if [ -f config.json ]; then cp -- config.json "$backup_root/"; fi
for name in "${allowed[@]}"; do
  if [ ! -e "$release_root/$name" ]; then continue; fi
  target="$project_root/$name"
  case "$target" in "$project_root/"*) ;; *) echo '更新路径越界' >&2; exit 1;; esac
  rm -rf -- "$target"
  cp -a -- "$release_root/$name" "$target"
done
bash scripts/install.sh "$@"
echo "升级完成，数据和 config.json 已保留；源码备份：$backup_root"
echo '运行 npm run start:background 启动新版本。'
