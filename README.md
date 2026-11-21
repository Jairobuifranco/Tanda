# 🛍️ TEAMU: The Great Parcel Race

> **A 2-minute, 300-player race where every player is a parcel. Tilt your phone to roll through a warehouse maze, spin for a perk, grab coupons, dodge Customs Holds and get Delivered first.**

Built by team **Teamu** for a hackathon. It's a shopping-app parody in a bright orange theme. One big screen shows the whole warehouse and every parcel in real time, and each player's phone is a tilt controller over Wi-Fi.

---

## 🎮 The 2-Minute Sale

Every sale lasts exactly **120 seconds**:

1. **Join & Spin**: Scan the QR code, pick a name and parcel colour, then spin the **Lucky Wheel** for a perk:
   - 🚚 **Express Shipping**: +20% speed all race
   - 🛡️ **Insured Parcel**: bounce out of one Customs Hold per race
   - 🧲 **Coupon Magnet**: grab coupons from further away
   - 😅 **Better Luck Next Time**: no perk, pure skill
2. **The Warehouse (start)**: All parcels spawn in the top-left `WAREHOUSE`.
3. **The Aisles**: Narrow, single-lane corridors full of dead ends (generated from `MAZE_SEED`). The phone shows "Out for delivery" progress.
4. **🏷️ Coupons**: 30 price tags ($1–$10) are scattered through the aisles and restock elsewhere when grabbed. Each one adds to your **savings**, shown on your phone and the leaderboard.
5. **🚫 12 Customs Holds**: Pulsing red traps, several right on the fastest route. While open they pull nearby parcels in, and touching one **reroutes** you to a hold no closer to the door. While closed (dashed ring) they're safe to cross.
6. **🏠 Delivered (finish)**: Reach the customer's door in the bottom-right. First in wins!
7. **The Podium**: Top 3 deliveries plus two awards:
   - 💸 **Bargain Hunter**: most coupon savings
   - 📦 **Lost Parcel Award**: most reroutes

---

## 📱 Phone Controller (`/play`)

- **Instant Join**: Pick a shopper name and parcel colour.
- **Lucky Wheel**: One spin per shopper. The server rolls the perk and the wheel animates to it.
- **Tilt Steering**: Tilt left/right/forward/back to roll your parcel.
- **Wallet & Perk Chips**: Live coupon savings and your active perk.
- **One-Tap Re-Calibration** and a **Touchpad Fallback** for phones without gyro access.
- **Alerts**: Coupon "cha-ching" toasts, a "Package rerouted!" banner, an insurance-claimed banner and Delivered haptics.

---

## 🚀 Quickstart Guide (1-Command Start & Stop)

### 1. Start the Demo (Launches Game Server + HTTPS Tunnel)
```bash
./start.sh
```
This automatically:
- Starts the game server on port 8000.
- Launches the Cloudflare HTTPS tunnel for instant mobile phone access.
- Prints the exact URLs and updates the on-screen QR code!

### 2. Stop the Demo (Clean Shutdown)
```bash
./stop.sh
```
This immediately terminates the Python server and the Cloudflare tunnel, leaving port 8000 clean.

---

## 🌐 Joining on the Same Wi-Fi Network

1. Connect your phone to the **same Wi-Fi network** as your computer.
2. Open the Host Display on your computer: [http://localhost:8000/](http://localhost:8000/).
3. A large QR code and URL (e.g. `http://192.168.201.26:8000/play`) will appear on screen.
4. Open the camera app on your phone and tap the banner to join immediately!

> **Note on iOS Gyroscope Permission**: When joining on iPhone/iPad Safari, tap the big **"ENABLE TILT & JOIN"** button and select **"Allow"** when prompted to enable tilt motion sensors. If denied, the on-screen touch controller automatically activates.

---

## 🤖 Simulating 300 Racers (Solo & Demo Mode)

You can demo and stress-test the full 300-parcel sale without needing 300 phones:

1. **From the Host Screen**:
   - In the lobby or race view, click **`🤖 Bots`** (or press `B`).
   - Select **`+50 Bots`**, **`+150 Bots`**, or **`+300 Full Swarm`**.
   - Press **`SPACEBAR`** to watch 300 bot parcels hunt coupons, wait out Customs Holds and race for the door!

2. **From the Terminal (CLI Stress Test)**:
   ```bash
   python3 test_bots.py 300
   ```
