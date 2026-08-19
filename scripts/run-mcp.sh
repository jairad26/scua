#!/bin/zsh
set -euo pipefail

SCUA_ROOT="${0:A:h:h}"
export PI_COMPUTER_USE_HEADLESS="false"
export PI_COMPUTER_USE_CURSOR_OVERLAY="true"
export PI_COMPUTER_USE_EXECUTION_MODE="${PI_COMPUTER_USE_EXECUTION_MODE:-background}"

exec /usr/bin/env node "${SCUA_ROOT}/mcp/server.ts"
