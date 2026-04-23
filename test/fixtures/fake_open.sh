#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 || "$1" != "-a" ]]; then
  echo "fake-open: expected '-a <app>'" >&2
  exit 64
fi

app_path="$2"
nohup "$app_path/Contents/MacOS/launch" >/dev/null 2>&1 &
exit 0
