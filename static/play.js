/**
 * TEAMU: THE GREAT PARCEL RACE - Mobile Gyroscope Controller Logic
 */

const BALL_COLORS = [
  "#1E88E5", "#E91E63", "#00A86B", "#FFB300",
  "#8E24AA", "#8D6E63", "#263238", "#00ACC1"
];

// Lucky wheel: 8 slices, two per perk (the server decides the result; we animate to it)
const WHEEL_SLICES = [
  { perk: 'express', emoji: '🚚', label: 'EXPRESS', color: '#FB7701', text: '#fff' },
  { perk: 'none',    emoji: '😅', label: 'TRY AGAIN', color: '#FFFFFF', text: '#7A6A5E' },
  { perk: 'magnet',  emoji: '🧲', label: 'MAGNET', color: '#E02020', text: '#fff' },
  { perk: 'insured', emoji: '🛡️', label: 'INSURED', color: '#FFF1E5', text: '#D95F00' },
  { perk: 'express', emoji: '🚚', label: 'EXPRESS', color: '#FB7701', text: '#fff' },
  { perk: 'none',    emoji: '😅', label: 'TRY AGAIN', color: '#FFFFFF', text: '#7A6A5E' },
  { perk: 'magnet',  emoji: '🧲', label: 'MAGNET', color: '#E02020', text: '#fff' },
  { perk: 'insured', emoji: '🛡️', label: 'INSURED', color: '#FFF1E5', text: '#D95F00' },
];

class PlayerController {
  constructor() {
    this.ws = null;
    this.player = null;
    this.selectedColorIdx = 0;
    this.isGyroActive = true;

    // Gyroscope tracking
    this.hasGyroHardware = false;
    this.baseBeta = 35.0; // Standard comfortable resting angle (degrees)
    this.tiltX = 0.0;
    this.tiltY = 0.0;

    // Touchpad fallback
    this.isTouching = false;
    this.touchStartX = 0;
    this.touchStartY = 0;

    // DOM Elements
    this.joinScreen = document.getElementById('join-screen');
    this.gameScreen = document.getElementById('game-screen');
    this.gameOverScreen = document.getElementById('game-over-screen');

    this.marble = document.getElementById('level-marble');
    this.disc = document.getElementById('level-disc');
    this.readoutX = document.getElementById('readout-x');
    this.readoutY = document.getElementById('readout-y');

    this.ctrlTimer = document.getElementById('ctrl-timer');
    this.ctrlRank = document.getElementById('ctrl-rank');
    this.progFill = document.getElementById('prog-fill-bar');
    this.progText = document.getElementById('prog-pct-text');
    this.hudStatus = document.getElementById('hud-racer-status');
    this.warpBanner = document.getElementById('warp-banner');
    this.finishedBanner = document.getElementById('finished-banner');
    this.hasTriggeredFinish = false;

    this.spinScreen = document.getElementById('spin-screen');
    this.wheelCanvas = document.getElementById('wheel-canvas');
    this.wheelAngle = 0;
    this.hasSpun = false;
    this.lastPhase = 'LOBBY';
    this.perk = 'none';
    this.perkInfo = null;
    this.lastSavings = 0;
    this.couponTimer = null;

    // Mini-map state
    this.map = null;              // {maze, holes, start, goal}
    this.mapCanvas = document.getElementById('minimap');
    this.mapBase = null;          // pre-rendered maze (offscreen canvas)
    this.holeRadii = [];
    this.me = null;               // target position from server
    this.meShown = null;          // interpolated position for drawing
    this.warpTrail = null;        // {from:[x,y], to:[x,y], start}
    window.addEventListener('resize', () => this.sizeMiniMap());
    requestAnimationFrame((t) => this.renderMiniMap(t));

    this.drawWheel(0);
    this.initColorSwatches();
    this.initTouchControls();
    this.loadSavedName();

    // Loop for sending tilt input to server at 15 Hz
    setInterval(() => this.sendTiltInput(), 66);
  }

  loadSavedName() {
    const saved = localStorage.getItem('racer_callsign');
    if (saved) {
      document.getElementById('player-name-input').value = saved;
    }
  }

  initColorSwatches() {
    const swatches = document.querySelectorAll('.swatch');
    swatches.forEach(swatch => {
      swatch.addEventListener('click', () => {
        swatches.forEach(s => s.classList.remove('selected'));
        swatch.classList.add('selected');
        this.selectedColorIdx = parseInt(swatch.getAttribute('data-idx'), 10);
      });
    });
  }

  async setupGyroscope() {
    if (
      typeof DeviceOrientationEvent !== 'undefined' &&
      typeof DeviceOrientationEvent.requestPermission === 'function'
    ) {
      try {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission === 'granted') {
          window.addEventListener('deviceorientation', (e) => this.handleDeviceOrientation(e));
          this.hasGyroHardware = true;
          return true;
        }
      } catch (err) {
        console.warn('Gyro permission prompt error:', err);
      }
    } else if ('ondeviceorientation' in window) {
      window.addEventListener('deviceorientation', (e) => this.handleDeviceOrientation(e));
      this.hasGyroHardware = true;
      return true;
    }

    // If gyro is unavailable, automatically enable Touchpad Mode
    this.isGyroActive = false;
    this.updateModeButtonUI();
    return false;
  }

  handleDeviceOrientation(event) {
    if (!this.isGyroActive || this.isTouching) return;

    const gamma = event.gamma; // Left-Right: -90 to +90
    const beta = event.beta;   // Front-Back: -180 to +180

    if (gamma === null || beta === null) return;
    this.hasGyroHardware = true;

    // Relative to calibrated baseline
    const rawX = gamma;
    const rawY = beta - this.baseBeta;

    // Apply 2.5 degree deadzone to prevent resting drift
    const deadzone = 2.5;
    let clampedX = 0.0;
    let clampedY = 0.0;

    if (Math.abs(rawX) > deadzone) {
      clampedX = Math.sign(rawX) * ((Math.abs(rawX) - deadzone) / 30.0);
    }
    if (Math.abs(rawY) > deadzone) {
      clampedY = Math.sign(rawY) * ((Math.abs(rawY) - deadzone) / 30.0);
    }

    this.tiltX = Math.max(-1.0, min(1.0, clampedX));
    this.tiltY = Math.max(-1.0, min(1.0, clampedY));

    this.updateMarbleUI(this.tiltX, this.tiltY);
    this.readoutX.textContent = `${Math.round(rawX)}°`;
    this.readoutY.textContent = `${Math.round(rawY)}°`;
  }

  recalibrate() {
    // Record current pitch as baseline
    this.baseBeta = 35.0; // Default reset
    this.hudStatus.textContent = 'CALIBRATED!';
    setTimeout(() => {
      this.hudStatus.textContent = this.isGyroActive ? 'GYRO ACTIVE' : 'TOUCHPAD ACTIVE';
    }, 1200);

    window.sfx.playWallClack();
    if (navigator.vibrate) navigator.vibrate(20);
  }

  toggleMode() {
    this.isGyroActive = !this.isGyroActive;
    this.updateModeButtonUI();
    window.sfx.playWallClack();
  }

  updateModeButtonUI() {
    const btn = document.getElementById('btn-mode-toggle');
    if (this.isGyroActive) {
      btn.textContent = '📱 GYROSCOPE';
      btn.classList.add('active');
      this.hudStatus.textContent = 'TILT PHONE TO ROLL';
    } else {
      btn.textContent = '🕹️ TOUCH PAD';
      btn.classList.remove('active');
      this.hudStatus.textContent = 'DRAG DISC TO TILT';
    }
  }

  initTouchControls() {
    const area = document.getElementById('tilt-pad-area');

    const handleStart = (clientX, clientY) => {
      const rect = this.disc.getBoundingClientRect();
      this.touchCenterX = rect.left + rect.width / 2;
      this.touchCenterY = rect.top + rect.height / 2;
      this.touchRadius = rect.width / 2;
      this.isTouching = true;
      handleMove(clientX, clientY);
    };

    const handleMove = (clientX, clientY) => {
      if (!this.isTouching) return;
      const dx = clientX - this.touchCenterX;
      const dy = clientY - this.touchCenterY;

      // Normalize to radius
      this.tiltX = Math.max(-1.0, min(1.0, dx / (this.touchRadius * 0.85)));
      this.tiltY = Math.max(-1.0, min(1.0, dy / (this.touchRadius * 0.85)));

      this.updateMarbleUI(this.tiltX, this.tiltY);
      this.readoutX.textContent = `${Math.round(this.tiltX * 30)}°`;
      this.readoutY.textContent = `${Math.round(this.tiltY * 30)}°`;
    };

    const handleEnd = () => {
      this.isTouching = false;
      if (!this.isGyroActive) {
        this.tiltX = 0.0;
        this.tiltY = 0.0;
        this.updateMarbleUI(0, 0);
      }
    };

    // Touch events
    area.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length > 0) handleStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    area.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length > 0) handleMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });

    area.addEventListener('touchend', (e) => {
      e.preventDefault();
      handleEnd();
    }, { passive: false });

    // Mouse events (for desktop testing)
    area.addEventListener('mousedown', (e) => {
      handleStart(e.clientX, e.clientY);
      const onMouseMove = (ev) => handleMove(ev.clientX, ev.clientY);
      const onMouseUp = () => {
        handleEnd();
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    });
  }

  updateMarbleUI(tx, ty) {
    // Keep the parcel inside the disc whatever size the disc is rendered at
    const maxOffset = Math.max(20, this.disc.clientWidth / 2 - this.marble.clientWidth / 2 - 6);
    const mx = tx * maxOffset;
    const my = ty * maxOffset;
    this.marble.style.transform = `translate(calc(-50% + ${mx}px), calc(-50% + ${my}px))`;
  }

  sendTiltInput() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.player) {
      this.ws.send(JSON.stringify({
        type: 'tilt',
        x: Math.round(this.tiltX * 100) / 100,
        y: Math.round(this.tiltY * 100) / 100,
      }));
    }
  }

  connectWS(name) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        type: 'join',
        name: name,
        color_idx: this.selectedColorIdx,
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('WS Error:', err);
      }
    };

    this.ws.onclose = () => {
      setTimeout(() => {
        if (this.player) this.connectWS(this.player.name);
      }, 2000);
    };
  }

  handleMessage(msg) {
    if (msg.type === 'welcome') {
      this.player = msg.player;
      localStorage.setItem('racer_callsign', this.player.name);

      // Apply player color to UI
      const color = this.player.color || BALL_COLORS[0];
      document.documentElement.style.setProperty('--player-color', color);
      document.getElementById('hud-player-name').textContent = this.player.name;

      if (msg.map) {
        this.map = msg.map;
        this.mapBase = null;   // re-render maze base
      }

      this.perk = this.player.perk || 'none';
      this.perkInfo = msg.perk_info || null;
      this.lastPhase = msg.phase;
      this.updatePerkChip();

      this.joinScreen.style.display = 'none';
      if (!this.hasSpun) {
        // First join: spin the lucky wheel before taking control
        this.spinScreen.style.display = 'flex';
        this.gameScreen.style.display = 'none';
        this.gameOverScreen.style.display = 'none';
      } else {
        this.showPhaseScreen(msg.phase);
      }
    } else if (msg.type === 'player_tick') {
      this.updateState(msg);
    } else if (msg.type === 'you_warped') {
      this.triggerWarpAlert(msg);
    } else if (msg.type === 'you_finished') {
      this.triggerFinishAlert(msg);
    } else if (msg.type === 'you_coupon') {
      this.triggerCouponToast(msg);
    } else if (msg.type === 'you_insured') {
      this.triggerInsuredAlert(msg);
    }
  }

  // --------------------------------------------------------------------------
  // Mini-map: your parcel on the maze, with live Customs Hold state
  // --------------------------------------------------------------------------
  sizeMiniMap() {
    if (!this.map || this.gameScreen.style.display === 'none') return false;
    const card = document.getElementById('map-card');
    const legendH = 22;
    const avail = Math.floor(Math.min(card.clientWidth - 16, card.clientHeight - 16 - legendH));
    if (avail <= 40) return false;
    const dpr = window.devicePixelRatio || 1;
    if (this.mapCssSize !== avail) {
      this.mapCssSize = avail;
      this.mapCanvas.style.width = `${avail}px`;
      this.mapCanvas.style.height = `${avail}px`;
      this.mapCanvas.width = avail * dpr;
      this.mapCanvas.height = avail * dpr;
      this.mapBase = null;
    }
    return true;
  }

  buildMapBase() {
    const { maze, start, goal } = this.map;
    const n = maze.length;
    const px = this.mapCanvas.width;
    const cell = px / n;
    const off = document.createElement('canvas');
    off.width = px; off.height = px;
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#FFF8F2';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#FB7701';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (maze[r][c] === 1) ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
      }
    }
    // Warehouse + door markers
    ctx.strokeStyle = '#263238';
    ctx.lineWidth = Math.max(1, cell * 0.12);
    ctx.setLineDash([cell * 0.4, cell * 0.25]);
    ctx.strokeRect((start[0] - 1.5) * cell, (start[1] - 1.5) * cell, cell * 3, cell * 3);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(18, 161, 80, 0.25)';
    ctx.beginPath();
    ctx.arc(goal[0] * cell, goal[1] * cell, cell * 1.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${cell * 1.6}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏠', goal[0] * cell, goal[1] * cell);
    this.mapBase = off;
  }

  renderMiniMap(nowMs) {
    requestAnimationFrame((t) => this.renderMiniMap(t));
    if (!this.map || !this.sizeMiniMap()) return;
    if (!this.mapBase) this.buildMapBase();

    const ctx = this.mapCanvas.getContext('2d');
    const px = this.mapCanvas.width;
    const cell = px / this.map.maze.length;
    ctx.drawImage(this.mapBase, 0, 0);

    // Customs Holds: solid when open (dangerous), dashed ring when closed (safe)
    this.map.holes.forEach(([hx, hy], i) => {
      const rad = this.holeRadii[i] || 0;
      ctx.beginPath();
      if (rad >= 0.08) {
        ctx.fillStyle = 'rgba(224, 32, 32, 0.15)';
        ctx.arc(hx * cell, hy * cell, cell * 2.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.fillStyle = '#E02020';
        ctx.arc(hx * cell, hy * cell, Math.max(cell * 0.3, rad * cell), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(224, 32, 32, 0.6)';
        ctx.lineWidth = Math.max(1, cell * 0.1);
        ctx.setLineDash([cell * 0.2, cell * 0.2]);
        ctx.arc(hx * cell, hy * cell, cell * 0.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });

    // Reroute trail: dashed arc from the hold you fell into to where you came out
    if (this.warpTrail) {
      const t = (nowMs - this.warpTrail.start) / 2500;
      if (t >= 1) {
        this.warpTrail = null;
      } else {
        const [fx, fy] = this.warpTrail.from.map(v => v * cell);
        const [tx, ty] = this.warpTrail.to.map(v => v * cell);
        const mx = (fx + tx) / 2;
        const my = (fy + ty) / 2 - Math.hypot(tx - fx, ty - fy) * 0.25;
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = '#1F1A17';
        ctx.lineWidth = Math.max(2, cell * 0.25);
        ctx.setLineDash([cell * 0.6, cell * 0.4]);
        ctx.lineDashOffset = -nowMs * 0.03;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.quadraticCurveTo(mx, my, tx, ty);
        ctx.stroke();
        ctx.restore();
      }
    }

    // You: smoothed toward the latest server position
    if (this.me && this.meShown) {
      this.meShown[0] += (this.me[0] - this.meShown[0]) * 0.3;
      this.meShown[1] += (this.me[1] - this.meShown[1]) * 0.3;
      const x = this.meShown[0] * cell;
      const y = this.meShown[1] * cell;
      const color = (this.player && this.player.color) || '#1E88E5';

      // Pulsing locator ring (bigger + faster right after a reroute)
      const boosted = this.warpTrail ? 1.8 : 1;
      const phase = (nowMs / (boosted > 1 ? 450 : 900)) % 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, cell * 0.2);
      ctx.globalAlpha = 1 - phase;
      ctx.beginPath();
      ctx.arc(x, y, cell * (0.7 + phase * 1.6 * boosted), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const s = Math.max(5, cell * 0.85);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#1F1A17';
      ctx.lineWidth = Math.max(1.5, cell * 0.14);
      ctx.beginPath();
      ctx.roundRect(x - s / 2, y - s / 2, s, s, s * 0.25);
      ctx.fill();
      ctx.stroke();
    }
  }

  findMe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'locate_me' }));
    if (navigator.vibrate) navigator.vibrate(20);
    const btn = document.getElementById('btn-find-me');
    btn.disabled = true;
    btn.textContent = '👀 LOOK UP!';
    setTimeout(() => { btn.disabled = false; btn.textContent = '📍 FIND ME'; }, 2000);
  }

  showPhaseScreen(phase) {
    this.spinScreen.style.display = 'none';
    if (phase === 'OVER') {
      this.gameOverScreen.style.display = 'flex';
      this.gameScreen.style.display = 'none';
    } else {
      this.gameScreen.style.display = 'flex';
      this.gameOverScreen.style.display = 'none';
    }
  }

  updatePerkChip() {
    const chip = document.getElementById('hud-perk');
    const info = this.perkInfo;
    if (!info || this.perk === 'none') {
      chip.textContent = '😅 No perk';
    } else {
      chip.textContent = `${info.emoji} ${info.label}`;
    }
  }

  // --------------------------------------------------------------------------
  // Lucky wheel
  // --------------------------------------------------------------------------
  drawWheel(angle) {
    const ctx = this.wheelCanvas.getContext('2d');
    const size = this.wheelCanvas.width;
    const r = size / 2;
    const n = WHEEL_SLICES.length;
    const slice = (Math.PI * 2) / n;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(r, r);
    ctx.rotate(angle);
    WHEEL_SLICES.forEach((s, i) => {
      // Slice i is centred on angle i*slice, measured from 12 o'clock
      const a0 = -Math.PI / 2 + i * slice - slice / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, r - 2, a0, a0 + slice);
      ctx.closePath();
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.strokeStyle = '#F2DFCF';
      ctx.lineWidth = 3;
      ctx.stroke();

      ctx.save();
      ctx.rotate(i * slice);
      ctx.textAlign = 'center';
      ctx.fillStyle = s.text;
      ctx.font = `${size * 0.075}px sans-serif`;
      ctx.fillText(s.emoji, 0, -r * 0.68);
      ctx.font = `900 ${size * 0.036}px Outfit, sans-serif`;
      ctx.fillText(s.label, 0, -r * 0.5);
      ctx.restore();
    });
    ctx.restore();
  }

  spin() {
    if (this.hasSpun || this.spinning) return;
    this.spinning = true;
    document.getElementById('btn-spin').disabled = true;
    window.sfx.init();

    // Pick a slice showing the perk the server rolled, then spin 5+ turns to land on it
    const n = WHEEL_SLICES.length;
    const sliceAngle = (Math.PI * 2) / n;
    const matches = WHEEL_SLICES.map((s, i) => (s.perk === this.perk ? i : -1)).filter(i => i >= 0);
    const target = matches[Math.floor(Math.random() * matches.length)];
    const jitter = (Math.random() - 0.5) * sliceAngle * 0.6;
    const finalAngle = Math.PI * 2 * 6 - target * sliceAngle + jitter;
    const duration = 3800;
    const start = performance.now();
    let lastTickSlice = -1;

    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      this.wheelAngle = finalAngle * eased;
      this.drawWheel(this.wheelAngle);

      const sliceIdx = Math.floor((this.wheelAngle + sliceAngle / 2) / sliceAngle);
      if (sliceIdx !== lastTickSlice) {
        lastTickSlice = sliceIdx;
        window.sfx.playRollTick();
        if (navigator.vibrate) navigator.vibrate(5);
      }

      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        this.spinning = false;
        this.hasSpun = true;
        this.showPerkResult();
      }
    };
    requestAnimationFrame(step);
  }

  showPerkResult() {
    const info = this.perkInfo || { emoji: '😅', label: 'Better Luck Next Time', desc: 'No perk. Pure skill!' };
    document.getElementById('perk-emoji').textContent = info.emoji;
    document.getElementById('perk-name').textContent = info.label;
    document.getElementById('perk-desc').textContent = info.desc;
    document.getElementById('perk-result').style.display = 'block';
    if (this.perk !== 'none') {
      window.sfx.playChaChing();
      if (navigator.vibrate) navigator.vibrate([40, 40, 80]);
    }
  }

  updateState(msg) {
    const totalSec = Math.max(0, Math.floor(msg.timer));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    this.ctrlTimer.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    this.ctrlRank.textContent = `#${msg.rank}`;
    this.progFill.style.width = `${msg.progress}%`;
    this.progText.textContent = `${msg.progress}%`;
    this.lastPhase = msg.phase;

    if (typeof msg.x === 'number') {
      this.me = [msg.x, msg.y];
      if (!this.meShown) this.meShown = [msg.x, msg.y];
    }
    if (msg.holes) this.holeRadii = msg.holes;

    const savings = msg.savings || 0;
    document.getElementById('hud-savings').textContent = `$${savings}`;
    if (savings < this.lastSavings) this.lastSavings = savings;  // new race reset

    // Screen transitions
    if (msg.phase === 'OVER') {
      if (this.gameScreen.style.display !== 'none') {
        this.gameScreen.style.display = 'none';
        this.gameOverScreen.style.display = 'flex';
        document.getElementById('final-rank').textContent = msg.finished ? `#${msg.finish_rank}` : `#${msg.rank}`;
        document.getElementById('final-warps').textContent = msg.warps;
        document.getElementById('final-savings').textContent = `$${savings}`;
      }
    } else if (msg.phase === 'PLAYING' || msg.phase === 'LOBBY') {
      if (this.gameOverScreen.style.display !== 'none' && this.player) {
        this.gameOverScreen.style.display = 'none';
        this.gameScreen.style.display = 'flex';
        this.finishedBanner.style.display = 'none';
        this.hasTriggeredFinish = false;
      }
    }
  }

  showBanner(icon, title, details, insured = false) {
    document.getElementById('warp-icon').textContent = icon;
    document.getElementById('warp-title').textContent = title;
    document.getElementById('warp-details').textContent = details;
    this.warpBanner.classList.toggle('insured', insured);
    this.warpBanner.style.display = 'flex';
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => {
      this.warpBanner.style.display = 'none';
    }, 1400);
  }

  triggerWarpAlert(msg) {
    window.sfx.playWarp();
    if (navigator.vibrate) navigator.vibrate([60, 80, 60]);
    this.showBanner('📦', 'PACKAGE REROUTED!', `Stuck at ${msg.from} ➔ now at ${msg.to}. Check your map!`);
    if (msg.from_xy && msg.to_xy) {
      this.warpTrail = { from: msg.from_xy, to: msg.to_xy, start: performance.now() };
      // Jump the marker straight to the exit hold instead of sliding across the map
      this.me = msg.to_xy.slice();
      this.meShown = msg.to_xy.slice();
    }
  }

  triggerInsuredAlert(msg) {
    window.sfx.playChaChing();
    if (navigator.vibrate) navigator.vibrate([30, 30, 30]);
    this.showBanner('🛡️', 'INSURANCE CLAIMED!', `Your parcel bounced out of ${msg.hole}. That was your one free pass!`, true);
    this.perk = 'none';
    this.perkInfo = { emoji: '🛡️', label: 'Insurance used' };
    document.getElementById('hud-perk').textContent = '🛡️ Insurance used';
  }

  triggerCouponToast(msg) {
    window.sfx.playChaChing();
    if (navigator.vibrate) navigator.vibrate(15);
    const toast = document.getElementById('coupon-toast');
    toast.textContent = msg.value >= 10 ? `🔥 +$${msg.value} MEGA COUPON!` : `+$${msg.value} COUPON! 💸`;
    toast.classList.toggle('mega', msg.value >= 10);
    // restart the CSS animation
    toast.style.display = 'none';
    void toast.offsetWidth;
    toast.style.display = 'block';
    clearTimeout(this.couponTimer);
    this.couponTimer = setTimeout(() => { toast.style.display = 'none'; }, 900);

    document.getElementById('hud-savings').textContent = `$${msg.savings}`;
    const chip = document.querySelector('.savings-chip');
    chip.classList.remove('bump');
    void chip.offsetWidth;
    chip.classList.add('bump');
  }

  triggerFinishAlert(msg) {
    if (this.hasTriggeredFinish) return;
    this.hasTriggeredFinish = true;

    window.sfx.playGoalFanfare();
    if (navigator.vibrate) navigator.vibrate([100, 50, 100, 50, 150]);

    document.getElementById('finish-rank-text').textContent = `Rank #${msg.rank} • arrived in ${msg.time}s`;
    this.finishedBanner.style.display = 'block';

    setTimeout(() => {
      this.finishedBanner.style.display = 'none';
    }, 3500);
  }
}

// Global functions invoked from HTML
function min(a, b) { return a < b ? a : b; }

window.playerCtrl = new PlayerController();

window.joinGame = async function() {
  const nameInput = document.getElementById('player-name-input');
  const name = nameInput.value.trim() || `Shopper-${Math.floor(Math.random() * 90 + 10)}`;
  window.sfx.init();

  // Request gyro permission on user interaction
  await window.playerCtrl.setupGyroscope();
  window.playerCtrl.connectWS(name);
};

window.quickRandomName = function() {
  const prefixes = ['Bargain', 'DealHunter', 'CartKing', 'Coupon', 'FlashSale', 'Unboxer', 'Haul', 'Promo', 'Freebie', 'Checkout'];
  const name = `${prefixes[Math.floor(Math.random() * prefixes.length)]}-${Math.floor(Math.random() * 90 + 10)}`;
  document.getElementById('player-name-input').value = name;
};

window.recalibrateGyro = function() {
  window.playerCtrl.recalibrate();
};

window.toggleControlMode = function() {
  window.playerCtrl.toggleMode();
};

window.spinWheel = function() {
  window.playerCtrl.spin();
};

window.goToController = function() {
  window.playerCtrl.showPhaseScreen(window.playerCtrl.lastPhase);
};

window.findMe = function() {
  window.playerCtrl.findMe();
};
