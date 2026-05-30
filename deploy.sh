#!/bin/bash
# Quick deploy: restart the MCP video renderer service
set -e
cd /var/lib/hermes/mcp-video-renderer
echo "Restarting mcp-video-renderer..."
sudo systemctl restart mcp-video-renderer
sleep 2
# Health check
RESP=$(curl -sf http://localhost:3100/health 2>&1)
if [ $? -eq 0 ]; then
  echo "✅ $RESP"
else
  echo "❌ Health check failed"
  sudo journalctl -u mcp-video-renderer --since "10 sec ago" --no-pager
  exit 1
fi
