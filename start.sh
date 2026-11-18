#!/usr/bin/env sh
# Engineering AI Console - minimal launcher (no resident background daemons).
set -e
cd "$(dirname "$0")"

for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >/dev/null 2>&1; then
    if [ "$#" -eq 0 ]; then
      # No arguments: stop the local service about 5 seconds after the last console tab closes.
      exec "$candidate" server.py --auto-exit
    fi
    exec "$candidate" server.py "$@"
  fi
done

echo
echo "Python 3.9 or newer was not found on this computer."
echo "Opening the prebuilt static console in pure static direct mode..."
echo "In this mode channels and API keys are kept in this browser only."
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open dist/index.html
elif command -v open >/dev/null 2>&1; then
  open dist/index.html
else
  echo "Open dist/index.html manually in your browser."
fi
