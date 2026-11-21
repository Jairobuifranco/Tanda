#!/bin/bash
# TEAMU Parcel Race - Clean Shutdown Script

echo "🛑 Stopping TEAMU Parcel Race Server and Cloudflare Tunnel..."

# Gracefully terminate python server and cloudflared processes
pkill -f "python3 server.py" 2>/dev/null
pkill -f "server.py" 2>/dev/null
pkill -f "cloudflared" 2>/dev/null

# Ensure port 8000 is forcibly freed if still lingering
PORT_PID=$(lsof -ti :8000 2>/dev/null)
if [ -n "$PORT_PID" ]; then
    kill -9 $PORT_PID 2>/dev/null
fi

sleep 0.5
echo "✅ All servers and tunnels stopped. Port 8000 is clean!"
