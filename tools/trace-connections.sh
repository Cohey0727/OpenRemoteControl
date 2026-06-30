#!/bin/bash
# Run claude --remote-control in background, sample its TCP connections
# every 500ms, and print them. Stops when claude exits or after N seconds.

DURATION=${1:-15}

env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY \
  CLAUDE_BRIDGE_BASE_URL=wss://127.0.0.1:8765 \
  CLAUDE_BRIDGE_OAUTH_TOKEN=dummy-token \
  CLAUDE_BRIDGE_USE_CCR_V2=true \
  claude --remote-control >/dev/null 2>&1 &
CLAUDE_PID=$!

echo "claude pid: $CLAUDE_PID"
echo "sampling TCP connections for ${DURATION}s..."
echo "---"

END=$(($(date +%s) + DURATION))
while [ $(date +%s) -lt $END ] && kill -0 $CLAUDE_PID 2>/dev/null; do
  lsof -p $CLAUDE_PID 2>/dev/null | grep -E 'TCP|IPv4|IPv6' | grep -v LISTEN | head -10
  sleep 0.5
done

echo "---"
echo "stopping claude..."
kill -INT $CLAUDE_PID 2>/dev/null
wait $CLAUDE_PID 2>/dev/null
echo "done"