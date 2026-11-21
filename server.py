#!/usr/bin/env python3
"""
TEAMU: THE GREAT PARCEL RACE - Game Server
A 2-minute, 300-player gyroscope parcel race through a warehouse maze:
spin for a perk, grab coupons, dodge Customs Holds, get Delivered.
Powered by pure Python 3 standard library (asyncio + RFC 6455). Zero dependencies.
"""

import asyncio
import base64
import collections
import hashlib
import json
import math
import mimetypes
import os
import random
import socket
import struct
import subprocess
import time
import urllib.parse
from typing import Dict, List, Optional, Set, Tuple

PORT = int(os.environ.get("PORT", 8000))
MATCH_DURATION = 120.0  # Exactly 2 minutes
PHYSICS_FPS = 30
PHYSICS_DT = 1.0 / PHYSICS_FPS
BALL_RADIUS = 0.32
HOLE_RADIUS = 0.75  # max (fully open) Red Hole radius
GOAL_RADIUS = 1.25

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# Parcel colours: readable on the light warehouse floor, distinct from the orange shelving
BALL_COLORS = [
    "#1E88E5",  # Blue
    "#E91E63",  # Pink
    "#00A86B",  # Green
    "#FFB300",  # Amber
    "#8E24AA",  # Purple
    "#8D6E63",  # Cardboard
    "#263238",  # Charcoal
    "#00ACC1",  # Teal
]

# Spin-the-wheel perks (rolled server-side on join; the phone animates the wheel to it)
PERKS = {
    "express": {"label": "Express Shipping", "emoji": "🚚", "desc": "+20% speed all race"},
    "insured": {"label": "Insured Parcel", "emoji": "🛡️", "desc": "Escape 1 Customs Hold per race"},
    "magnet":  {"label": "Coupon Magnet", "emoji": "🧲", "desc": "Grab coupons from further away"},
    "none":    {"label": "Better Luck Next Time", "emoji": "😅", "desc": "No perk. Pure skill!"},
}
PERK_KEYS = list(PERKS.keys())
EXPRESS_SPEED_MULT = 1.2

# Coupons scattered through the aisles
COUPON_COUNT = 30
COUPON_RADIUS = 0.25
MAGNET_REACH = 1.3
COUPON_VALUES = [1, 1, 2, 2, 3, 3, 5, 5, 10]   # dollars, weighted toward small

# -----------------------------------------------------------------------------
# Detect Host LAN IP for Wi-Fi QR Code
# -----------------------------------------------------------------------------
def get_lan_ip() -> str:
    try:
        out = subprocess.check_output(["ifconfig"], text=True)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("inet ") and not line.startswith("inet 127."):
                parts = line.split()
                if len(parts) >= 2:
                    return parts[1]
    except Exception:
        pass
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

LAN_IP = get_lan_ip()


# -----------------------------------------------------------------------------
# Standalone RFC 6455 WebSocket Framing & Connection
# -----------------------------------------------------------------------------
class WSConnection:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.closed = False

    async def send_text(self, text: str):
        if self.closed:
            return
        data = text.encode("utf-8")
        length = len(data)
        if length < 126:
            header = struct.pack("!BB", 0x81, length)
        elif length < 65536:
            header = struct.pack("!BBH", 0x81, 126, length)
        else:
            header = struct.pack("!BBQ", 0x81, 127, length)
        try:
            self.writer.write(header + data)
            await self.writer.drain()
        except Exception:
            self.closed = True

    async def send_json(self, obj: dict):
        await self.send_text(json.dumps(obj, separators=(",", ":")))

    async def read_frame(self) -> Optional[tuple[int, bytes]]:
        try:
            head = await self.reader.readexactly(2)
        except Exception:
            return None
        b1, b2 = head[0], head[1]
        opcode = b1 & 0x0F
        is_masked = bool(b2 & 0x80)
        length = b2 & 0x7F

        if length == 126:
            ext = await self.reader.readexactly(2)
            length = struct.unpack("!H", ext)[0]
        elif length == 127:
            ext = await self.reader.readexactly(8)
            length = struct.unpack("!Q", ext)[0]

        if is_masked:
            mask = await self.reader.readexactly(4)
            raw = await self.reader.readexactly(length)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(raw))
        else:
            payload = await self.reader.readexactly(length)

        return opcode, payload

    async def close(self):
        if not self.closed:
            self.closed = True
            try:
                self.writer.write(struct.pack("!BB", 0x88, 0))
                await self.writer.drain()
                self.writer.close()
                await self.writer.wait_closed()
            except Exception:
                pass


# -----------------------------------------------------------------------------
# Maze Definition & BFS Distance Field
# -----------------------------------------------------------------------------
# 27x27 Narrow-Corridor Maze (1 = Wall, 0 = Open corridor)
# Generated deterministically from MAZE_SEED: a recursive-backtracker "perfect"
# maze (1-tile corridors, lots of dead ends), then lightly braided so a few
# alternate routes exist. Change MAZE_SEED to get a different layout.
MAZE_SIZE = 27
MAZE_SEED = 251  # 115-tile shortest route, 47 turns
BRAID_CHANCE = 0.18  # chance a dead end gets knocked through into a loop


def generate_maze(size: int, seed: int) -> List[List[int]]:
    rng = random.Random(seed)
    grid = [[1] * size for _ in range(size)]
    cells = range(1, size - 1, 2)
    steps = [(-2, 0), (2, 0), (0, -2), (0, 2)]

    # Recursive backtracker (iterative) from the start corner
    grid[1][1] = 0
    stack = [(1, 1)]
    while stack:
        r, c = stack[-1]
        options = [(r + dr, c + dc, dr, dc) for dr, dc in steps
                   if 0 < r + dr < size - 1 and 0 < c + dc < size - 1 and grid[r + dr][c + dc] == 1]
        if not options:
            stack.pop()
            continue
        nr, nc, dr, dc = rng.choice(options)
        grid[r + dr // 2][c + dc // 2] = 0
        grid[nr][nc] = 0
        stack.append((nr, nc))

    # Braid: open some dead ends into neighbouring corridors to create loops
    for r in cells:
        for c in cells:
            open_dirs = [(dr, dc) for dr, dc in steps if grid[r + dr // 2][c + dc // 2] == 0]
            if len(open_dirs) == 1 and rng.random() < BRAID_CHANCE:
                walls = [(dr, dc) for dr, dc in steps
                         if (dr, dc) not in open_dirs and 0 < r + dr < size - 1 and 0 < c + dc < size - 1]
                if walls:
                    dr, dc = rng.choice(walls)
                    grid[r + dr // 2][c + dc // 2] = 0

    # Open 3x3 launch room and finish room
    for r0, c0 in [(1, 1), (size - 4, size - 4)]:
        for r in range(r0, r0 + 3):
            for c in range(c0, c0 + 3):
                grid[r][c] = 0
    return grid


MAZE_LAYOUT = generate_maze(MAZE_SIZE, MAZE_SEED)

GRID_H = len(MAZE_LAYOUT)
GRID_W = len(MAZE_LAYOUT[0])

# Start zone center and Goal zone center
START_POS = (2.5, 2.5)
GOAL_POS = (24.5, 24.5)

# Read active Cloudflare Tunnel URL if available
def get_tunnel_url() -> Optional[str]:
    t_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tunnel_url.txt")
    if os.path.isfile(t_file):
        try:
            with open(t_file, "r") as f:
                val = f.read().strip()
                if val.startswith("http"):
                    return val
        except Exception:
            pass
    return None

ACTIVE_TUNNEL_URL = get_tunnel_url()
def build_bfs_distance_field(grid, goal_r, goal_c):
    dist = [[9999 for _ in range(GRID_W)] for _ in range(GRID_H)]
    q = collections.deque([(goal_r, goal_c, 0)])
    dist[goal_r][goal_c] = 0
    max_d = 0
    while q:
        r, c, d = q.popleft()
        if d > max_d:
            max_d = d
        for dr, dc in [(-1,0), (1,0), (0,-1), (0,1)]:
            nr, nc = r + dr, c + dc
            if 0 <= nr < GRID_H and 0 <= nc < GRID_W and grid[nr][nc] == 0:
                if dist[nr][nc] > d + 1:
                    dist[nr][nc] = d + 1
                    q.append((nr, nc, d + 1))
    return dist, max_d

BFS_DISTANCES, MAX_DISTANCE = build_bfs_distance_field(MAZE_LAYOUT, int(GOAL_POS[1]), int(GOAL_POS[0]))


# -----------------------------------------------------------------------------
# Red Holes (Pulsing Gravity Wormholes)
# -----------------------------------------------------------------------------
# Holes pulse open and closed: while open they pull nearby balls in and warp
# anything that touches them; while closed they are safe to roll across.
HOLE_COUNT = 12
HOLES_ON_ROUTE = 5          # how many sit directly on the shortest route
HOLE_MIN_SPACING = 4.0      # min distance between holes (tiles)
HOLE_PULL_RADIUS = 2.2      # gravity reach (tiles)
HOLE_PULL_STRENGTH = 9.0    # peak pull accel (tilt accel is 14.0)
HOLE_OPEN_THRESHOLD = 0.08  # holes smaller than this can't swallow balls
WARP_IMMUNITY = 0.9         # seconds of immunity after a warp

HOLE_NAMES = [
    "Customs Hold", "Lost & Found", "Return Centre", "Sorting Depot", "Overseas Hub",
    "Address Unknown", "Damaged Goods", "Restock Bay", "Back-Order Pit", "Missed Delivery",
    "Clearance Bin", "Final Mile Trap",
]


def place_red_holes() -> List[dict]:
    rng = random.Random(MAZE_SEED + 1)

    # Shortest route from launch to finish, following the BFS gradient
    route = []
    r, c = int(START_POS[1]), int(START_POS[0])
    while BFS_DISTANCES[r][c] > 0:
        route.append((r, c))
        r, c = min(
            ((r + dr, c + dc) for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]
             if MAZE_LAYOUT[r + dr][c + dc] == 0),
            key=lambda rc: BFS_DISTANCES[rc[0]][rc[1]],
        )

    def far_from(cx, cy, picked):
        if math.hypot(cx - START_POS[0], cy - START_POS[1]) < 4.5:
            return False
        if math.hypot(cx - GOAL_POS[0], cy - GOAL_POS[1]) < 3.5:
            return False
        return all(math.hypot(cx - h[0], cy - h[1]) >= HOLE_MIN_SPACING for h in picked)

    picked: List[Tuple[float, float]] = []
    # 1. Holes spread along the main route
    for i in range(HOLES_ON_ROUTE):
        frac = 0.15 + 0.75 * i / max(1, HOLES_ON_ROUTE - 1)
        idx = int(frac * (len(route) - 1))
        for off in [0, 1, -1, 2, -2, 3, -3, 4, -4]:
            j = idx + off
            if 0 <= j < len(route):
                rr, cc = route[j]
                if far_from(cc + 0.5, rr + 0.5, picked):
                    picked.append((cc + 0.5, rr + 0.5))
                    break

    # 2. Remaining holes at junctions and corridors elsewhere
    junctions, corridors = [], []
    for rr in range(1, GRID_H - 1):
        for cc in range(1, GRID_W - 1):
            if MAZE_LAYOUT[rr][cc] != 0:
                continue
            n_open = sum(MAZE_LAYOUT[rr + dr][cc + dc] == 0 for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)])
            (junctions if n_open >= 3 else corridors).append((cc + 0.5, rr + 0.5))
    rng.shuffle(junctions)
    rng.shuffle(corridors)
    for cx, cy in junctions + corridors:
        if len(picked) >= HOLE_COUNT:
            break
        if far_from(cx, cy, picked):
            picked.append((cx, cy))

    return [
        {
            "id": i,
            "x": x,
            "y": y,
            "name": HOLE_NAMES[i % len(HOLE_NAMES)],
            "period": round(rng.uniform(2.4, 3.8), 2),  # seconds per open/close cycle
            "phase": round(rng.uniform(0, math.pi * 2), 2),
        }
        for i, (x, y) in enumerate(picked)
    ]


RED_HOLES = place_red_holes()
HOLE_CLOCK_START = time.monotonic()


def hole_goal_dist(hole: dict) -> int:
    return BFS_DISTANCES[int(hole["y"])][int(hole["x"])]


COUPON_CELLS = [
    (c + 0.5, r + 0.5)
    for r in range(GRID_H) for c in range(GRID_W)
    if MAZE_LAYOUT[r][c] == 0
    and math.hypot(c + 0.5 - START_POS[0], r + 0.5 - START_POS[1]) > 3.0
    and math.hypot(c + 0.5 - GOAL_POS[0], r + 0.5 - GOAL_POS[1]) > 2.5
    and all(math.hypot(c + 0.5 - h["x"], r + 0.5 - h["y"]) > 1.5 for h in RED_HOLES)
]


def hole_radius(hole: dict, now: float) -> float:
    """Current swallow radius: open ~60% of each cycle, fully closed the rest."""
    s = math.sin(2 * math.pi * (now - HOLE_CLOCK_START) / hole["period"] + hole["phase"])
    return HOLE_RADIUS * max(0.0, min(1.0, (s + 0.3) / 0.5))


# -----------------------------------------------------------------------------
# Physics Engine & Game Manager
# -----------------------------------------------------------------------------
class GyroMazeEngine:
    def __init__(self):
        self.phase = "LOBBY"  # LOBBY, PLAYING, OVER
        self.timer = MATCH_DURATION
        self.finished_count = 0
        self.podium: List[dict] = []

        # Connected Players: id -> dict
        self.players: Dict[str, dict] = {}
        self.ws_to_player: Dict[WSConnection, str] = {}
        self.hosts: Set[WSConnection] = set()

        # Simulated Bots
        self.bots: List[dict] = []

        self.events: List[dict] = []
        self.pending_events: List[dict] = []
        self.hole_radii: List[float] = [0.0] * len(RED_HOLES)
        self.coupons: List[dict] = []
        self.coupon_pickups: List[list] = []   # [x, y, value] since last host tick
        self.coupon_seq = 0
        self.respawn_coupons()

    def make_coupon(self) -> dict:
        taken = {(c["x"], c["y"]) for c in self.coupons}
        free = [cell for cell in COUPON_CELLS if cell not in taken]
        x, y = random.choice(free)
        self.coupon_seq += 1
        return {"id": self.coupon_seq, "x": x, "y": y, "value": random.choice(COUPON_VALUES)}

    def respawn_coupons(self):
        self.coupons = []
        for _ in range(COUPON_COUNT):
            self.coupons.append(self.make_coupon())

    def reset_game(self):
        self.phase = "LOBBY"
        self.timer = MATCH_DURATION
        self.finished_count = 0
        self.podium.clear()
        self.events.clear()
        self.pending_events.clear()
        self.coupon_pickups.clear()
        self.respawn_coupons()

        # Reset all balls to Start zone with slight random jitter
        all_participants = list(self.players.values()) + self.bots
        for p in all_participants:
            self.spawn_ball_at_start(p)

    def spawn_ball_at_start(self, player: dict):
        player["x"] = START_POS[0] + random.uniform(-0.8, 0.8)
        player["y"] = START_POS[1] + random.uniform(-0.8, 0.8)
        player["vx"] = 0.0
        player["vy"] = 0.0
        player["tilt_x"] = 0.0
        player["tilt_y"] = 0.0
        player["finished"] = False
        player["finish_rank"] = 0
        player["finish_time"] = 0.0
        player["warps"] = 0
        player["cooldown"] = 0.0
        player["progress"] = 0
        player["savings"] = 0
        player["coupons"] = 0
        player["shield"] = 1 if player.get("perk") == "insured" else 0

    def register_player(self, ws: Optional[WSConnection], name: str, color_idx: int = 0, is_bot=False) -> dict:
        player_id = f"p_{random.randint(100000, 999999)}"
        clean_name = (name.strip()[:14] if name.strip() else f"Racer-{random.randint(10, 99)}")
        c_idx = color_idx % len(BALL_COLORS)
        color = BALL_COLORS[c_idx]

        player = {
            "id": player_id,
            "name": clean_name,
            "color": color,
            "color_idx": c_idx,
            "x": START_POS[0],
            "y": START_POS[1],
            "vx": 0.0,
            "vy": 0.0,
            "tilt_x": 0.0,
            "tilt_y": 0.0,
            "finished": False,
            "finish_rank": 0,
            "finish_time": 0.0,
            "warps": 0,
            "cooldown": 0.0,
            "progress": 0,
            "is_bot": is_bot,
            "ws": ws,
            "perk": random.choice(PERK_KEYS),
        }
        self.spawn_ball_at_start(player)

        if is_bot:
            self.bots.append(player)
        else:
            self.players[player_id] = player
            if ws:
                self.ws_to_player[ws] = player_id

        self.add_event(f"🛒 {clean_name} joined the warehouse!", "join")
        return player

    def unregister_player(self, ws: WSConnection):
        player_id = self.ws_to_player.pop(ws, None)
        if player_id and player_id in self.players:
            p = self.players.pop(player_id)
            self.add_event(f"{p['name']} disconnected.", "leave")

    def update_tilt(self, player_id: str, tx: float, ty: float):
        p = self.players.get(player_id)
        if p and not p["finished"]:
            # Clamp tilt inputs between -1.0 and 1.0
            p["tilt_x"] = max(-1.0, min(1.0, float(tx)))
            p["tilt_y"] = max(-1.0, min(1.0, float(ty)))

    def locate_player(self, player_id: str):
        p = self.players.get(player_id)
        if not p:
            return
        now = time.time()
        if now - p.get("last_locate", 0) < 2.0:
            return
        p["last_locate"] = now
        self.pending_events.append({
            "id": f"loc_{int(now*1000)}_{random.randint(100, 999)}",
            "type": "locate",
            "player_id": p["id"],
            "player_name": p["name"],
        })

    def add_event(self, text: str, event_type: str = "info", coords: Optional[Tuple[float, float]] = None, **kwargs):
        evt_id = f"e_{int(time.time()*1000)}_{random.randint(100, 999)}"
        evt = {
            "id": evt_id,
            "text": text,
            "type": event_type,
            "coords": coords,
            "time": time.time(),
            **kwargs,
        }
        self.events.append(evt)
        if len(self.events) > 35:
            self.events.pop(0)
        self.pending_events.append(evt)

    def start_game(self):
        self.reset_game()
        self.phase = "PLAYING"
        self.timer = MATCH_DURATION
        self.add_event("🔥 THE SALE IS LIVE! 120 SECONDS TO GET DELIVERED!", "announcement")

    def toggle_bots(self, count: int):
        cur = len(self.bots)
        if count > cur:
            names = [
                "Bargain", "Deal", "Promo", "Coupon", "Cart", "Parcel", "Flash", "Discount",
                "Saver", "Haul", "Unbox", "Checkout", "Freebie", "Markdown", "Clearance", "Bundle",
                "Voucher", "Steal", "Restock", "Wishlist", "Basket", "Doorbuster", "Rebate", "Haggle"
            ]
            for i in range(count - cur):
                b_name = f"Bot-{random.choice(names)}{random.randint(10, 99)}"
                self.register_player(None, b_name, color_idx=random.randint(0, len(BALL_COLORS)-1), is_bot=True)
            self.add_event(f"🤖 Added {count - cur} simulated shoppers (Total bots: {len(self.bots)}).")
        elif count < cur:
            self.bots = self.bots[:count]
            self.add_event(f"🤖 Bots adjusted to {len(self.bots)}.")

    def clear_bots(self):
        self.bots.clear()
        self.add_event("🤖 All bots removed.")

    # -------------------------------------------------------------------------
    # Physics Simulation Step (30 Hz)
    # -------------------------------------------------------------------------
    def update_physics(self, dt: float):
        if self.phase != "PLAYING":
            return

        self.timer = max(0.0, self.timer - dt)

        all_balls = list(self.players.values()) + self.bots

        # Red Hole pulse state for this tick
        now = time.monotonic()
        self.hole_radii = [hole_radius(h, now) for h in RED_HOLES]

        # Bot AI: Navigate towards Goal using BFS distance field gradient
        for b in self.bots:
            if b["finished"]:
                b["vx"] *= 0.8
                b["vy"] *= 0.8
                continue

            r = int(max(0, min(GRID_H - 1, b["y"])))
            c = int(max(0, min(GRID_W - 1, b["x"])))
            cur_d = BFS_DISTANCES[r][c]

            # Look at neighbor cells to find shortest direction
            best_dir = (0.0, 0.0)
            best_d = cur_d
            for dr, dc in [(-1,0), (1,0), (0,-1), (0,1)]:
                nr, nc = r + dr, c + dc
                if 0 <= nr < GRID_H and 0 <= nc < GRID_W and MAZE_LAYOUT[nr][nc] == 0:
                    d = BFS_DISTANCES[nr][nc]
                    if d < best_d:
                        best_d = d
                        best_dir = (float(dc), float(dr))

            # Coupon hunting: detour for a coupon in this tile or an open neighbouring tile
            for cp in self.coupons:
                cr, cc = int(cp["y"]), int(cp["x"])
                if abs(cr - r) + abs(cc - c) <= 1 and MAZE_LAYOUT[cr][cc] == 0:
                    dx, dy = cp["x"] - b["x"], cp["y"] - b["y"]
                    d = math.hypot(dx, dy) or 1.0
                    best_dir = (dx / d, dy / d)
                    break

            # Hole timing: back away from an open hole nearby and wait for it to close
            # (each bot has its own nerve, so some get greedy and get swallowed)
            nerve = b.setdefault("nerve", random.uniform(1.0, 2.0))
            if b["cooldown"] <= 0:
                for hole, rad in zip(RED_HOLES, self.hole_radii):
                    if rad <= 0.0:
                        continue
                    dx = b["x"] - hole["x"]
                    dy = b["y"] - hole["y"]
                    d = math.hypot(dx, dy)
                    if 0.001 < d < nerve:
                        best_dir = (dx / d * 1.2, dy / d * 1.2)
                        break

            # Add human-like steering noise
            noise_x = random.uniform(-0.35, 0.35)
            noise_y = random.uniform(-0.35, 0.35)
            b["tilt_x"] = max(-1.0, min(1.0, best_dir[0] + noise_x))
            b["tilt_y"] = max(-1.0, min(1.0, best_dir[1] + noise_y))

        # Update each ball
        for p in all_balls:
            if p["finished"]:
                continue

            if p["cooldown"] > 0:
                p["cooldown"] = max(0.0, p["cooldown"] - dt)

            # Acceleration from tilt: max ~14.0 units/sec^2
            speed_mult = EXPRESS_SPEED_MULT if p.get("perk") == "express" else 1.0
            ax = p["tilt_x"] * 14.0 * speed_mult
            ay = p["tilt_y"] * 14.0 * speed_mult

            # Red Hole gravity: open holes drag nearby balls toward their core
            if p["cooldown"] <= 0:
                for hole, rad in zip(RED_HOLES, self.hole_radii):
                    if rad <= 0.0:
                        continue
                    dx = hole["x"] - p["x"]
                    dy = hole["y"] - p["y"]
                    d = math.hypot(dx, dy)
                    if 0.001 < d < HOLE_PULL_RADIUS:
                        pull = HOLE_PULL_STRENGTH * (1.0 - d / HOLE_PULL_RADIUS) * (rad / HOLE_RADIUS)
                        ax += dx / d * pull
                        ay += dy / d * pull

            # Velocity integration with friction
            p["vx"] = (p["vx"] + ax * dt) * 0.94
            p["vy"] = (p["vy"] + ay * dt) * 0.94

            # Terminal velocity clamp (prevents tunnel glitches through walls)
            speed_sq = p["vx"] * p["vx"] + p["vy"] * p["vy"]
            max_speed = 7.0 * speed_mult
            if speed_sq > max_speed * max_speed:  # 7.0 units/sec max (8.4 with Express)
                scale = max_speed / math.sqrt(speed_sq)
                p["vx"] *= scale
                p["vy"] *= scale

            # Position integration
            p["x"] += p["vx"] * dt
            p["y"] += p["vy"] * dt

            # Circle vs Wall Tile Collision Detection & Resolution
            self.resolve_wall_collisions(p)

            # Check Red Hole Teleportation
            self.check_red_hole_collision(p)

            # Coupon pickups
            self.check_coupon_pickup(p)

            # Check Goal Portal Collision
            self.check_goal_collision(p)

            # Update progress percent
            r = int(max(0, min(GRID_H - 1, p["y"])))
            c = int(max(0, min(GRID_W - 1, p["x"])))
            dist_left = BFS_DISTANCES[r][c]
            p["progress"] = max(0, min(100, int((1.0 - (dist_left / MAX_DISTANCE)) * 100)))

        # Check match timer expiration
        if self.timer <= 0:
            self.phase = "OVER"
            self.timer = 0.0
            self.add_event("⏰ SALE OVER! THE DELIVERY WINDOW HAS CLOSED!", "announcement")

    def resolve_wall_collisions(self, p: dict):
        x, y = p["x"], p["y"]
        vx, vy = p["vx"], p["vy"]
        rad = BALL_RADIUS

        min_c = max(0, int(x - rad - 1))
        max_c = min(GRID_W - 1, int(x + rad + 1))
        min_r = max(0, int(y - rad - 1))
        max_r = min(GRID_H - 1, int(y + rad + 1))

        for r in range(min_r, max_r + 1):
            for c in range(min_c, max_c + 1):
                if MAZE_LAYOUT[r][c] == 1:
                    # Tile bounding box [c, c+1] x [r, r+1]
                    nearest_x = max(float(c), min(x, float(c + 1)))
                    nearest_y = max(float(r), min(y, float(r + 1)))
                    dx = x - nearest_x
                    dy = y - nearest_y
                    dist_sq = dx * dx + dy * dy

                    if dist_sq < rad * rad:
                        dist = math.sqrt(dist_sq)
                        if dist > 0.0001:
                            nx = dx / dist
                            ny = dy / dist
                        else:
                            nx, ny = 1.0, 0.0
                            dist = 0.0

                        overlap = rad - dist
                        x += nx * overlap
                        y += ny * overlap

                        # Elastic bounce
                        dot = vx * nx + vy * ny
                        if dot < 0:
                            vx -= (1.0 + 0.4) * dot * nx
                            vy -= (1.0 + 0.4) * dot * ny

        p["x"] = x
        p["y"] = y
        p["vx"] = vx
        p["vy"] = vy

    def check_red_hole_collision(self, p: dict):
        if p["cooldown"] > 0:
            return

        for hole, rad in zip(RED_HOLES, self.hole_radii):
            if rad < HOLE_OPEN_THRESHOLD:
                continue  # closed: safe to roll across
            dx = p["x"] - hole["x"]
            dy = p["y"] - hole["y"]
            dist = math.sqrt(dx * dx + dy * dy)
            if dist < (BALL_RADIUS + rad):
                if p.get("shield", 0) > 0:
                    # Insured Parcel: bounce out once instead of being rerouted
                    p["shield"] -= 1
                    p["cooldown"] = WARP_IMMUNITY * 1.5
                    if dist > 0.001:
                        p["vx"] = dx / dist * 4.0
                        p["vy"] = dy / dist * 4.0
                    self.add_event(f"🛡️ {p['name']} claimed insurance and dodged {hole['name']}!", "insured")
                    self.notify(p, {"type": "you_insured", "hole": hole["name"]})
                    break
                # Warp to a random different hole that is NO closer to the finish,
                # so falling in is always a setback, never a shortcut.
                other_holes = [h for h in RED_HOLES if h["id"] != hole["id"]]
                worse = [h for h in other_holes if hole_goal_dist(h) >= hole_goal_dist(hole)]
                target = random.choice(worse) if worse else max(other_holes, key=hole_goal_dist)

                p["x"] = target["x"]
                p["y"] = target["y"]
                # Outward expulsion impulse
                angle = random.uniform(0, math.pi * 2)
                p["vx"] = math.cos(angle) * 3.8
                p["vy"] = math.sin(angle) * 3.8
                p["cooldown"] = WARP_IMMUNITY
                p["warps"] += 1

                self.add_event(
                    f"📦 {p['name']} got stuck at {hole['name']} ➔ rerouted to {target['name']}!",
                    "warp",
                    coords=(target["x"], target["y"]),
                    player_name=p["name"],
                    hole_name=hole["name"],
                    target_name=target["name"],
                    player_id=p["id"],
                    from_coords=(hole["x"], hole["y"]),
                    human=not p["is_bot"],
                )

                self.notify(p, {
                    "type": "you_warped",
                    "from": hole["name"],
                    "to": target["name"],
                    "from_xy": [hole["x"], hole["y"]],
                    "to_xy": [target["x"], target["y"]],
                    "warps": p["warps"]
                })
                break

    def notify(self, p: dict, msg: dict):
        ws = p.get("ws")
        if ws and not ws.closed:
            asyncio.create_task(ws.send_json(msg))

    def check_coupon_pickup(self, p: dict):
        reach = BALL_RADIUS + COUPON_RADIUS
        if p.get("perk") == "magnet":
            reach = MAGNET_REACH
        for i, cp in enumerate(self.coupons):
            dx = p["x"] - cp["x"]
            dy = p["y"] - cp["y"]
            if dx * dx + dy * dy < reach * reach:
                p["savings"] += cp["value"]
                p["coupons"] += 1
                self.coupon_pickups.append([cp["x"], cp["y"], cp["value"]])
                self.coupons[i] = self.make_coupon()   # restock elsewhere
                if cp["value"] >= 10:
                    self.add_event(f"💸 {p['name']} grabbed a $10 MEGA COUPON!", "coupon")
                self.notify(p, {"type": "you_coupon", "value": cp["value"], "savings": p["savings"]})

    def check_goal_collision(self, p: dict):
        if p["finished"]:
            return

        dx = p["x"] - GOAL_POS[0]
        dy = p["y"] - GOAL_POS[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < GOAL_RADIUS:
            p["finished"] = True
            self.finished_count += 1
            p["finish_rank"] = self.finished_count
            p["finish_time"] = round(MATCH_DURATION - self.timer, 2)
            p["vx"] = 0.0
            p["vy"] = 0.0

            self.podium.append({
                "rank": p["finish_rank"],
                "name": p["name"],
                "time": p["finish_time"],
                "color": p["color"],
                "warps": p["warps"],
                "savings": p["savings"],
            })

            self.add_event(
                f"🏠 {p['name']} GOT DELIVERED! (#{p['finish_rank']} in {p['finish_time']}s)",
                "goal",
                coords=GOAL_POS,
                player_name=p["name"],
                rank=p["finish_rank"],
                finish_time=p["finish_time"],
                player_id=p["id"],
            )

            self.notify(p, {
                "type": "you_finished",
                "rank": p["finish_rank"],
                "time": p["finish_time"],
            })

    # -------------------------------------------------------------------------
    # State Serialization & Leaderboard
    # -------------------------------------------------------------------------
    def get_leaderboard(self) -> List[dict]:
        all_b = list(self.players.values()) + self.bots
        # Sort: finished first by finish_rank, then unfinished by progress % descending
        finished = [p for p in all_b if p["finished"]]
        finished.sort(key=lambda x: x["finish_rank"])

        racing = [p for p in all_b if not p["finished"]]
        racing.sort(key=lambda x: x["progress"], reverse=True)

        combined = finished + racing
        return [
            {
                "id": p["id"],
                "name": p["name"],
                "color": p["color"],
                "progress": p["progress"],
                "finished": p["finished"],
                "rank": p["finish_rank"] if p["finished"] else (i + 1),
                "warps": p["warps"],
                "savings": p["savings"],
                "perk": p.get("perk", "none"),
            }
            for i, p in enumerate(combined[:10])
        ]


# Global Engine Instance
engine = GyroMazeEngine()


# -----------------------------------------------------------------------------
# WebSocket Message Dispatcher
# -----------------------------------------------------------------------------
async def handle_ws_client(ws: WSConnection):
    client_type = "UNKNOWN"
    registered_player_id = None

    try:
        while not ws.closed:
            res = await ws.read_frame()
            if res is None:
                break
            opcode, payload = res
            if opcode == 0x8:  # Close
                break
            elif opcode == 0x9:  # Ping
                await ws.writer.write(struct.pack("!BB", 0x8A, 0))
                await ws.writer.drain()
                continue
            elif opcode != 0x1:
                continue

            try:
                msg = json.loads(payload.decode("utf-8"))
            except Exception:
                continue

            mtype = msg.get("type")

            # Host Client
            if mtype == "host_init":
                client_type = "HOST"
                engine.hosts.add(ws)
                await ws.send_json({
                    "type": "host_full_init",
                    "phase": engine.phase,
                    "timer": round(engine.timer, 1),
                    "lan_ip": LAN_IP,
                    "tunnel_url": get_tunnel_url(),
                    "port": PORT,
                    "maze": MAZE_LAYOUT,
                    "red_holes": RED_HOLES,
                    "start_pos": START_POS,
                    "goal_pos": GOAL_POS,
                    "perks": PERKS,
                    "events": engine.events[-10:],
                })

            # Player Join
            elif mtype == "join":
                client_type = "PLAYER"
                name = msg.get("name", "Racer")
                color_idx = int(msg.get("color_idx", 0))
                player = engine.register_player(ws, name, color_idx)
                registered_player_id = player["id"]
                await ws.send_json({
                    "type": "welcome",
                    "player": {
                        "id": player["id"],
                        "name": player["name"],
                        "color": player["color"],
                        "color_idx": player["color_idx"],
                        "perk": player["perk"],
                    },
                    "perk_info": PERKS[player["perk"]],
                    "map": {
                        "maze": MAZE_LAYOUT,
                        "holes": [[h["x"], h["y"]] for h in RED_HOLES],
                        "start": START_POS,
                        "goal": GOAL_POS,
                    },
                    "phase": engine.phase,
                    "timer": round(engine.timer, 1),
                })

            # Gyro / Tilt Input
            elif mtype == "locate_me":
                if registered_player_id:
                    engine.locate_player(registered_player_id)

            elif mtype == "tilt":
                if registered_player_id:
                    tx = msg.get("x", 0.0)
                    ty = msg.get("y", 0.0)
                    engine.update_tilt(registered_player_id, tx, ty)

            # Host Controls
            elif mtype == "host_start":
                engine.start_game()
            elif mtype == "host_reset":
                engine.reset_game()
            elif mtype == "host_set_bots":
                count = int(msg.get("count", 0))
                engine.toggle_bots(count)
            elif mtype == "host_clear_bots":
                engine.clear_bots()

    finally:
        if client_type == "HOST":
            engine.hosts.discard(ws)
        else:
            engine.unregister_player(ws)
        await ws.close()


# -----------------------------------------------------------------------------
# Realtime Physics & Broadcast Loop (30 Hz)
# -----------------------------------------------------------------------------
async def game_loop():
    last_time = time.time()
    tick_counter = 0

    while True:
        await asyncio.sleep(PHYSICS_DT)
        now = time.time()
        dt = now - last_time
        last_time = now
        tick_counter += 1

        # Advance 2D physics
        engine.update_physics(dt)

        # 1. Broadcast to Host Screen (all balls, positions, events)
        if engine.hosts:
            all_b = list(engine.players.values()) + engine.bots
            # Compact ball representation: [id, x, y, color_idx, finished, warps, name, savings, is_human]
            balls_data = [
                [p["id"], round(p["x"], 2), round(p["y"], 2), p["color_idx"], 1 if p["finished"] else 0, p["warps"], p["name"], p["savings"], 0 if p["is_bot"] else 1]
                for p in all_b
            ]
            latest_ticker = engine.events[-1]["text"] if engine.events else ""
            events_to_send = list(engine.pending_events)
            engine.pending_events.clear()

            host_update = {
                "type": "host_tick",
                "phase": engine.phase,
                "timer": round(engine.timer, 1),
                "total_players": len(all_b),
                "finished_count": engine.finished_count,
                "balls": balls_data,
                "leaderboard": engine.get_leaderboard(),
                "podium": engine.podium[:5],
                "events": events_to_send,
                "ticker": latest_ticker,
                "hole_radii": [round(hole_radius(h, time.monotonic()), 2) for h in RED_HOLES],
                "coupons": [[c["x"], c["y"], c["value"]] for c in engine.coupons],
                "coupon_pickups": engine.coupon_pickups,
            }
            engine.coupon_pickups = []
            payload = json.dumps(host_update, separators=(",", ":"))
            dead_hosts = []
            for h in engine.hosts:
                try:
                    await h.send_text(payload)
                except Exception:
                    dead_hosts.append(h)
            for dh in dead_hosts:
                engine.hosts.discard(dh)

        engine.coupon_pickups = []  # don't accumulate when no host screen is open

        # 2. Broadcast to Mobile Players every 3 ticks (~10 Hz)
        if tick_counter % 3 == 0 and engine.players:
            leaderboard = engine.get_leaderboard()
            now_mono = time.monotonic()
            hole_state = [round(hole_radius(h, now_mono), 2) for h in RED_HOLES]
            dead_players = []
            for pid, player in engine.players.items():
                ws = player.get("ws")
                if not ws or ws.closed:
                    dead_players.append(pid)
                    continue

                # Find personal rank
                personal_rank = 1
                for item in leaderboard:
                    if item["id"] == pid:
                        personal_rank = item["rank"]
                        break

                player_msg = {
                    "type": "player_tick",
                    "phase": engine.phase,
                    "timer": round(engine.timer, 1),
                    "rank": personal_rank,
                    "progress": player["progress"],
                    "warps": player["warps"],
                    "finished": player["finished"],
                    "finish_rank": player["finish_rank"],
                    "savings": player["savings"],
                    "coupons": player["coupons"],
                    "shield": player["shield"],
                    "x": round(player["x"], 2),
                    "y": round(player["y"], 2),
                    "holes": hole_state,
                }
                try:
                    await ws.send_json(player_msg)
                except Exception:
                    dead_players.append(pid)

            for dpid in dead_players:
                if dpid in engine.players:
                    p = engine.players[dpid]
                    if p.get("ws"):
                        engine.unregister_player(p["ws"])


# -----------------------------------------------------------------------------
# HTTP Server & Router
# -----------------------------------------------------------------------------
async def handle_http_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        req_line = await reader.readline()
        if not req_line:
            writer.close()
            return
        parts = req_line.decode("latin1").strip().split(" ")
        if len(parts) < 2:
            writer.close()
            return
        method, full_path = parts[0], parts[1]

        headers = {}
        while True:
            line = await reader.readline()
            if not line or line == b"\r\n" or line == b"\n":
                break
            line_str = line.decode("latin1").strip()
            if ":" in line_str:
                k, v = line_str.split(":", 1)
                headers[k.strip().lower()] = v.strip()

        # WebSocket Upgrade
        if headers.get("upgrade", "").lower() == "websocket":
            sec_key = headers.get("sec-websocket-key")
            if not sec_key:
                writer.close()
                return
            accept_val = base64.b64encode(
                hashlib.sha1((sec_key + WS_GUID).encode("utf-8")).digest()
            ).decode("utf-8")
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
            )
            writer.write(response.encode("utf-8"))
            await writer.drain()

            ws = WSConnection(reader, writer)
            await handle_ws_client(ws)
            return

        # Static HTTP
        parsed = urllib.parse.urlparse(full_path)
        path = parsed.path

        if path in ("/", "/host", "/index.html"):
            target_file = os.path.join(STATIC_DIR, "index.html")
        elif path in ("/play", "/play.html"):
            target_file = os.path.join(STATIC_DIR, "play.html")
        elif path == "/ip":
            body = json.dumps({"ip": LAN_IP, "port": PORT}).encode("utf-8")
            res = (
                f"HTTP/1.1 200 OK\r\n"
                f"Content-Type: application/json\r\n"
                f"Content-Length: {len(body)}\r\n"
                f"Access-Control-Allow-Origin: *\r\n\r\n"
            ).encode("utf-8") + body
            writer.write(res)
            await writer.drain()
            writer.close()
            return
        else:
            rel_path = path.lstrip("/")
            target_file = os.path.join(STATIC_DIR, rel_path)

        if os.path.isfile(target_file) and os.path.commonpath([STATIC_DIR, target_file]) == STATIC_DIR:
            mime, _ = mimetypes.guess_type(target_file)
            mime = mime or "application/octet-stream"
            with open(target_file, "rb") as f:
                content = f.read()
            res_headers = (
                f"HTTP/1.1 200 OK\r\n"
                f"Content-Type: {mime}\r\n"
                f"Content-Length: {len(content)}\r\n"
                f"Cache-Control: no-cache\r\n\r\n"
            ).encode("utf-8")
            writer.write(res_headers + content)
        else:
            not_found = b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found"
            writer.write(not_found)

        await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main():
    server = await asyncio.start_server(handle_http_client, "0.0.0.0", PORT)
    print("=" * 65)
    print("📦 TEAMU: THE GREAT PARCEL RACE - Server Running!")
    print(f"🖥️  Host Screen (Big Display): http://{LAN_IP}:{PORT}/")
    print(f"📱 Phone Controller (Wi-Fi):  http://{LAN_IP}:{PORT}/play")
    print(f"🌐 Local Machine:             http://localhost:{PORT}/")
    print("=" * 65)

    asyncio.create_task(game_loop())

    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped.")
