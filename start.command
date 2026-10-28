#!/bin/sh
# macOS Finder entry point. See START_HERE.md if archive permissions were lost.
cd -- "$(dirname -- "$0")" || exit 1
sh ./start.sh "$@"
result=$?
if [ "$result" -ne 0 ]; then
  printf '%s\n' '启动失败，请查看上面的提示。按回车关闭。 / Press Enter to close.'
  read -r unused
fi
exit "$result"
