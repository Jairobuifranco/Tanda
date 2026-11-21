#!/bin/bash
# GYRO MAZE 300 - Quick Status Checker

echo "========================================================"
echo "🌀 GYRO MAZE 300 - STATUS CHECK"
echo "========================================================"

# 1. Check if server process is running or port 8000 is bound
PORT_PID=$(lsof -ti :8000 2>/dev/null | head -n 1)
SERVER_PID=$(pgrep -f "server.py" 2>/dev/null | head -n 1)

if [ -n "$PORT_PID" ] || [ -n "$SERVER_PID" ]; then
    echo "🟢 Game Server: RUNNING"
    echo "   • PID:  ${SERVER_PID:-$PORT_PID}"
    echo "   • Port: 8000 (Active)"
    echo "   • Local URL: http://localhost:8000"
else
    echo "🔴 Game Server: STOPPED (Port 8000 is free)"
fi

echo ""

# 2. Check Cloudflare Tunnel
TUNNEL_PID=$(pgrep -f "cloudflared" 2>/dev/null | head -n 1)
if [ -n "$TUNNEL_PID" ]; then
    echo "🟢 Cloudflare HTTPS Tunnel: RUNNING (PID: $TUNNEL_PID)"
    if [ -f tunnel_url.txt ] && [ -s tunnel_url.txt ]; then
        URL=$(cat tunnel_url.txt)
        echo "   • Public Host URL:   $URL"
        echo "   • Mobile Player URL: $URL/play"
    elif [ -f tunnel.log ]; then
        URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' tunnel.log 2>/dev/null | head -n 1)
        if [ -n "$URL" ]; then
            echo "   • Public Host URL:   $URL"
            echo "   • Mobile Player URL: $URL/play"
        fi
    fi
else
    echo "⚪ Cloudflare Tunnel: NOT RUNNING"
fi

echo "========================================================"
if [ -z "$PORT_PID" ] && [ -z "$SERVER_PID" ]; then
    echo "💡 To start the game, run: ./start.sh"
else
    echo "💡 To view live logs, run:  tail -f server.log"
    echo "💡 To stop the game, run:  ./stop.sh"
fi
echo "========================================================"
