#!/bin/sh
set -eu

if [ -z "${BRAGI_SERVER_URL:-}" ]; then
  echo "BRAGI_SERVER_URL must be set to the browser-accessible BragiServer URL." >&2
  exit 1
fi

printf '%s' "$BRAGI_SERVER_URL" > /usr/share/nginx/html/server-url.txt
