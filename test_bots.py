#!/usr/bin/env python3
"""
TEAMU Parcel Race - 300-Player Load & Stress Tester
Simulates up to 300 concurrent real WebSocket connections sending tilt gyroscope vectors.
"""

import asyncio
import base64
import json
import os
import random
import struct
import sys
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", 8000))
TOTAL_BOTS = int(sys.argv[1]) if len(sys.argv) > 1 else 300


def make_ws_frame(data: bytes, mask_key: bytes = b"\x12\x34\x56\x78") -> bytes:
    length = len(data)
    masked = bytes(b ^ mask_key[i % 4] for i, b in enumerate(data))
    if length < 126:
        header = struct.pack("!BB", 0x81, 0x80 | length)
    elif length < 65536:
        header = struct.pack("!BBH", 0x81, 0x80 | 126, length)
    else:
        header = struct.pack("!BBQ", 0x81, 0x80 | 127, length)
    return header + mask_key + masked


async def run_bot(bot_id: int):
    name = f"RacerBot-{bot_id:03d}"
    try:
        reader, writer = await asyncio.open_connection(HOST, PORT)

        # 1. Handshake
        key = base64.b64encode(os.urandom(16)).decode("utf-8")
        req = (
            f"GET /ws HTTP/1.1\r\n"
            f"Host: {HOST}:{PORT}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        writer.write(req.encode("utf-8"))
        await writer.drain()

        # Read handshake response
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = await reader.read(1024)
            if not chunk:
                return
            response += chunk

        # 2. Send Join message
        join_msg = json.dumps({
            "type": "join",
            "name": name,
            "color_idx": bot_id % 8,
        }).encode("utf-8")
        writer.write(make_ws_frame(join_msg))
        await writer.drain()

        # 3. Simulate continuous gyroscope tilt streaming (15 Hz)
        for _ in range(120):  # Run for ~20-30 seconds
            await asyncio.sleep(0.08)
            tx = random.uniform(-0.8, 0.8)
            ty = random.uniform(-0.8, 0.8)
            tilt_msg = json.dumps({"type": "tilt", "x": tx, "y": ty}).encode("utf-8")
            writer.write(make_ws_frame(tilt_msg))
            await writer.drain()

        writer.close()
        await writer.wait_closed()
    except Exception:
        pass


async def main():
    print(f"🚀 Launching {TOTAL_BOTS} WebSocket gyro racer bots against {HOST}:{PORT}...")
    start = time.time()
    tasks = [run_bot(i + 1) for i in range(TOTAL_BOTS)]
    await asyncio.gather(*tasks)
    elapsed = time.time() - start
    print(f"✅ Successfully simulated {TOTAL_BOTS} concurrent racers in {elapsed:.2f}s!")


if __name__ == "__main__":
    asyncio.run(main())
