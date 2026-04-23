#!/usr/bin/env bash
# Mock "Chrome for Testing" binary used by temp-browser-manager tests.
# Accepts Chrome's flag syntax (--flag=value or --flag value) and supports
# a few test-only directives for simulating launch failures.
set -u

BW_FAIL_START=0
BW_EXIT_AFTER=0           # milliseconds; 0 = never exit on its own
BW_STARTUP_DELAY=0        # milliseconds; block startup for this long
BW_EMIT_STDERR=""
BW_EMIT_STDOUT=""

# Parse args. Ignore all Chrome flags; only intercept our test directives.
for arg in "$@"; do
  case "$arg" in
    --bw-fail-start)
      BW_FAIL_START=1
      ;;
    --bw-exit-after=*)
      BW_EXIT_AFTER="${arg#--bw-exit-after=}"
      ;;
    --bw-startup-delay=*)
      BW_STARTUP_DELAY="${arg#--bw-startup-delay=}"
      ;;
    --bw-emit-stderr=*)
      BW_EMIT_STDERR="${arg#--bw-emit-stderr=}"
      ;;
    --bw-emit-stdout=*)
      BW_EMIT_STDOUT="${arg#--bw-emit-stdout=}"
      ;;
  esac
done

if [[ -n "$BW_EMIT_STDOUT" ]]; then
  printf "%s\n" "$BW_EMIT_STDOUT"
fi
if [[ -n "$BW_EMIT_STDERR" ]]; then
  printf "%s\n" "$BW_EMIT_STDERR" >&2
fi

if [[ "$BW_FAIL_START" == "1" ]]; then
  echo "fake-chrome: simulated startup failure" >&2
  exit 1
fi

if [[ "$BW_STARTUP_DELAY" -gt 0 ]]; then
  # Block without responding to signals to simulate hung start.
  python3 -c "import time; time.sleep(${BW_STARTUP_DELAY}/1000.0)"
fi

if [[ "$BW_EXIT_AFTER" -gt 0 ]]; then
  python3 -c "import time; time.sleep(${BW_EXIT_AFTER}/1000.0)"
  exit 0
fi

# Normal path: stay alive until SIGTERM/SIGINT.
trap 'exit 0' TERM INT
while true; do
  sleep 3600 &
  wait $!
done
