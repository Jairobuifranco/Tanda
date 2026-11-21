#!/bin/bash
# TEAMU Parcel Race - Demo Quick Launcher

cd "$(dirname "$0")"

# 1. Kill any existing instances first
./stop.sh >/dev/null 2>&1

echo "========================================================"
echo "📦 Starting TEAMU: The Great Parcel Race Game Server & Cloudflare Tunnel..."
echo "========================================================"

# 2. Launch server.py in background
PYTHON_BIN=$(which python3.13 2>/dev/null || which python3)
$PYTHON_BIN server.py > server.log 2>&1 &
SERVER_PID=$!
echo "✅ Game Server launched (PID: $SERVER_PID) on port 8000 using $PYTHON_BIN"

# 3. Launch Cloudflare Tunnel
CLOUDFLARED_BIN=$(which cloudflared || echo "/opt/homebrew/bin/cloudflared")
if [ -x "$CLOUDFLARED_BIN" ]; then
    rm -f tunnel.log tunnel_url.txt
    "$CLOUDFLARED_BIN" tunnel --url http://localhost:8000 > tunnel.log 2>&1 &
    TUNNEL_PID=$!
    echo "⏳ Establishing secure HTTPS tunnel (for mobile gyro access)..."

    # Wait up to 10 seconds to extract the generated trycloudflare URL
    TUNNEL_URL=""
    for i in {1..20}; do
        TUNNEL_URL=$(grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' tunnel.log 2>/dev/null | head -n 1)
        if [ -n "$TUNNEL_URL" ]; then
            break
        fi
        sleep 0.5
    done

    if [ -n "$TUNNEL_URL" ]; then
        echo "$TUNNEL_URL" > tunnel_url.txt
        echo "========================================================"
        echo "🎉 DEMO IS LIVE READY FOR PLAYERS!"
        echo "🖥️  Host Display (Big Screen):  $TUNNEL_URL"
        echo "📱 Phone Controller (Players): $TUNNEL_URL/play"
        echo "🌐 Localhost (Computer):       http://localhost:8000"
        echo "========================================================"
    else
        echo "⚠️ Tunnel launched. Check tunnel.log if URL hasn't printed yet."
    fi
else
    echo "========================================================"
    echo "🎉 SERVER RUNNING LOCALLY!"
    echo "🖥️  Host Screen: http://localhost:8000/"
    echo "📱 Phone Controller: http://localhost:8000/play"
    echo "========================================================"
fi
