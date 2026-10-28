#!/bin/sh
# Works from any working directory, including paths containing spaces.
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'H3Mise: 请先安装 Node.js 22.13 或更新版本，再重新启动。' \
    'Install Node.js 22.13 or newer: https://nodejs.org/'
  exit 1
fi
exec node scripts/launch.mjs "$@"
