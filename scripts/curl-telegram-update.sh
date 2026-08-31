#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
webhook_url="${TELEGRAM_WEBHOOK_URL:-http://localhost:8787/telegram/webhook}"

# This intentionally sends no bot token or webhook secret. With the default
# disabled local configuration the expected response is the safe 404. If the
# webhook capability is enabled, the request is rejected before bot
# initialization (401), so this remains a no-network/token smoke of the HTTP
# boundary. The fake Bot API path is covered by Vitest.
curl --silent --show-error --include \
  --request POST \
  --header "Content-Type: application/json" \
  --data-binary "@${script_dir}/../test/fixtures/telegram-update.json" \
  "${webhook_url}"
