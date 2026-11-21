/**
 * TEAMU: THE GREAT PARCEL RACE - Host Display Controller & 60 FPS Canvas Renderer
 */

const BALL_COLORS = [
  "#1E88E5", "#E91E63", "#00A86B", "#FFB300",
  "#8E24AA", "#8D6E63", "#263238", "#00ACC1"
];

class HostController {
  constructor() {
    this.ws = null;
    this.phase = 'LOBBY';
    this.timer = 120.0;
    this.lastSecond = 120;
    this.lanIp = '127.0.0.1';
    this.port = 8000;

    // Maze Data
    this.maze = null;
    this.gridW = 27;
    this.gridH = 27;
    this.redHoles = [];
    this.holeRadii = [];
    this.coupons = [];         // [x, y, value]
    this.locators = new Map(); // player id -> {start, until, from:[x,y]|null, name}
    this.lastChaChing = 0;
    this.startPos = [2.5, 2.5];
    this.goalPos = [24.5, 24.5];

    // Balls & FX
    this.balls = []; // [id, x, y, color_idx, finished, warps, name]
    this.particles = [];
    this.confetti = [];
    this.screenShake = 0;
    this.processedEvents = new Set();

    // DOM Elements
    this.mazeCanvas = document.getElementById('maze-canvas');
    this.mazeCtx = this.mazeCanvas.getContext('2d');
    this.fxCanvas = document.getElementById('fx-canvas');
    this.fxCtx = this.fxCanvas.getContext('2d');
    this.confettiCanvas = document.getElementById('confetti-canvas');
    this.confettiCtx = this.confettiCanvas.getContext('2d');

    this.timerDisplay = document.getElementById('timer-display');
    this.phaseBadge = document.getElementById('phase-badge');
    this.playerCountEl = document.getElementById('player-count');
    this.counterSub = document.getElementById('counter-sub');
    this.tickerFeed = document.getElementById('ticker-feed');
    this.leaderboardList = document.getElementById('leaderboard-list');
    this.finishedTag = document.getElementById('finished-count-tag');
    this.botCountTag = document.getElementById('bot-count-tag');

    this.lobbyModal = document.getElementById('lobby-modal');
    this.victoryModal = document.getElementById('victory-modal');
    this.lobbyCountNum = document.getElementById('lobby-count-num');

    this.initCanvases();
    this.initEventListeners();
    this.connectWS();

    requestAnimationFrame(this.renderLoop.bind(this));
  }

  initCanvases() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.mazeCanvas.parentElement.getBoundingClientRect();
    const size = Math.floor(Math.min(rect.width, rect.height) || 760);

    [this.mazeCanvas, this.fxCanvas].forEach(c => {
      c.width = size * dpr;
      c.height = size * dpr;
      c.style.width = `${size}px`;
      c.style.height = `${size}px`;
    });

    this.mazeCtx.scale(dpr, dpr);
    this.fxCtx.scale(dpr, dpr);
    this.canvasSize = size;

    this.confettiCanvas.width = window.innerWidth * dpr;
    this.confettiCanvas.height = window.innerHeight * dpr;
    this.confettiCtx.scale(dpr, dpr);
  }

  initEventListeners() {
    window.addEventListener('resize', () => this.initCanvases());

    document.getElementById('btn-start-match').addEventListener('click', () => this.startRace());
    document.getElementById('btn-lobby-start').addEventListener('click', () => this.startRace());
    document.getElementById('btn-reset-match').addEventListener('click', () => this.resetRace());
    document.getElementById('btn-play-again').addEventListener('click', () => this.resetRace());

    document.getElementById('btn-toggle-sound').addEventListener('click', (e) => {
      const isMuted = window.sfx.toggleMute();
      e.target.textContent = isMuted ? '🔇' : '🔊';
      e.target.classList.toggle('btn-muted', isMuted);
    });

    const btnMusic = document.getElementById('btn-toggle-music');
    if (window.music && !window.music.enabled) {
      btnMusic.textContent = '🔇';
      btnMusic.classList.add('btn-muted');
    }
    btnMusic.addEventListener('click', (e) => {
      if (!window.music) return;
      const enabled = window.music.toggle();
      e.target.textContent = enabled ? '🎵' : '🔇';
      e.target.classList.toggle('btn-muted', !enabled);
    });

    const btnAnnouncer = document.getElementById('btn-toggle-announcer');
    if (window.announcer && !window.announcer.enabled) {
      btnAnnouncer.textContent = '🤐';
      btnAnnouncer.classList.add('btn-muted');
    }
    btnAnnouncer.addEventListener('click', (e) => {
      if (!window.announcer) return;
      const enabled = window.announcer.toggle();
      e.target.textContent = enabled ? '🎙️' : '🤐';
      e.target.classList.toggle('btn-muted', !enabled);
    });

    document.getElementById('btn-bot-menu').addEventListener('click', () => window.toggleBotDialog());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.phase === 'LOBBY' || this.phase === 'OVER') this.startRace();
      } else if (e.key === 's' || e.key === 'S') {
        const isMuted = window.sfx.toggleMute();
        const btn = document.getElementById('btn-toggle-sound');
        btn.textContent = isMuted ? '🔇' : '🔊';
        btn.classList.toggle('btn-muted', isMuted);
      } else if (e.key === 'm' || e.key === 'M') {
        if (!window.music) return;
        const enabled = window.music.toggle();
        const btn = document.getElementById('btn-toggle-music');
        btn.textContent = enabled ? '🎵' : '🔇';
        btn.classList.toggle('btn-muted', !enabled);
      } else if (e.key === 'a' || e.key === 'A') {
        if (!window.announcer) return;
        const enabled = window.announcer.toggle();
        const btn = document.getElementById('btn-toggle-announcer');
        btn.textContent = enabled ? '🎙️' : '🤐';
        btn.classList.toggle('btn-muted', !enabled);
      } else if (e.key === 'b' || e.key === 'B') {
        window.toggleBotDialog();
      }
    });
  }

  connectWS() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: 'host_init' }));
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
      setTimeout(() => this.connectWS(), 1500);
    };
  }

  handleMessage(msg) {
    if (msg.type === 'host_full_init') {
      this.phase = msg.phase;
      this.timer = msg.timer;
      this.lanIp = msg.lan_ip || window.location.hostname;
      this.tunnelUrl = msg.tunnel_url || null;
      this.port = msg.port || 8000;
      this.maze = msg.maze;
      this.gridH = this.maze.length;
      this.gridW = this.maze[0].length;
      this.redHoles = msg.red_holes || [];
      this.startPos = msg.start_pos || [2.5, 2.5];
      this.goalPos = msg.goal_pos || [24.5, 24.5];

      this.updateJoinURLs();
      this.syncModals();
    } else if (msg.type === 'host_tick') {
      const prevPhase = this.phase;
      this.phase = msg.phase;
      this.timer = msg.timer;
      this.balls = msg.balls || [];
      if (msg.hole_radii) this.holeRadii = msg.hole_radii;
      if (msg.coupons) this.coupons = msg.coupons;
      if (msg.coupon_pickups && msg.coupon_pickups.length) {
        msg.coupon_pickups.forEach(([x, y, v]) => this.spawnCouponBurst(x, y, v));
        const nowMs = performance.now();
        if (nowMs - this.lastChaChing > 350) {   // throttle: 300 bots grabbing coupons
          this.lastChaChing = nowMs;
          if (window.sfx.playChaChing) window.sfx.playChaChing();
        }
      }

      // Match Start Cue
      if (prevPhase === 'LOBBY' && this.phase === 'PLAYING') {
        if (window.music) window.music.start();
        if (window.announcer) window.announcer.onRaceStart();
      } else if (prevPhase !== 'LOBBY' && this.phase === 'LOBBY') {
        if (window.music) window.music.stop();
        if (window.announcer && window.announcer.synth) window.announcer.synth.cancel();
      }

      // Sound and timer cues during race
      const sec = Math.floor(this.timer);
      if (this.phase === 'PLAYING') {
        if (window.music) window.music.updatePhase(this.timer);

        if (sec !== this.lastSecond) {
          this.lastSecond = sec;
          if (sec <= 10 && sec > 0) window.sfx.playTick(true);
          if (sec === 30 || sec === 10) {
            if (window.announcer) window.announcer.onFinalCountdown(sec);
          }
        }

        // Track live leader change
        if (msg.leaderboard && msg.leaderboard.length > 0 && window.announcer) {
          const leader = msg.leaderboard[0];
          window.announcer.onLeaderChange(leader.name, leader.id);
        }
      }

      // Check events for sounds and FX (processed exactly once in the moment)
      if (msg.events && msg.events.length > 0) {
        msg.events.forEach(evt => {
          if (evt.id && this.processedEvents.has(evt.id)) return;
          if (evt.id) this.processedEvents.add(evt.id);

          if (evt.type === 'locate' && evt.player_id) {
            this.addLocator(evt.player_id, evt.player_name, null);
          } else if (evt.type === 'warp' && evt.coords) {
            window.sfx.playWarp();
            this.spawnWarpSparks(evt.coords[0], evt.coords[1]);
            if (evt.human && evt.player_id) {
              this.addLocator(evt.player_id, evt.player_name, evt.from_coords || null);
            }
            if (window.announcer) {
              const isTop = msg.leaderboard && msg.leaderboard[0] && 
                            (msg.leaderboard[0].name === evt.player_name || msg.leaderboard[0].id === evt.player_id);
              window.announcer.onWarp(evt.player_name || 'A shopper', evt.hole_name || 'Customs', isTop);
            }
          } else if (evt.type === 'coupon' && window.announcer) {
            window.announcer.onMegaCoupon(evt.text.replace(/^💸 /, '').split(' grabbed')[0]);
          } else if (evt.type === 'goal' && evt.coords) {
            window.sfx.playGoalFanfare();
            this.spawnGoalFireworks(evt.coords[0], evt.coords[1]);
            if (window.announcer) {
              const rank = evt.rank || (msg.podium ? msg.podium.length : 1);
              if (rank === 1) {
                window.announcer.onFirstPlaceFinish(evt.player_name || 'A racer', evt.finish_time || '45');
              } else if (rank === 2) {
                window.announcer.onSecondPlaceFinish(evt.player_name || 'A racer');
              } else if (rank === 3) {
                window.announcer.onThirdPlaceFinish(evt.player_name || 'A racer');
              }
            }
          }
        });

        if (this.processedEvents.size > 200) {
          this.processedEvents.clear();
        }
      }

      // Match Completion
      if (prevPhase === 'PLAYING' && this.phase === 'OVER') {
        if (window.music) window.music.stop();
        if (window.announcer) window.announcer.onRaceOver(msg.podium);
        window.sfx.playBuzzer();
        setTimeout(() => {
          window.sfx.playGoalFanfare();
          this.triggerConfetti();
        }, 500);
      }

      this.updateHUD(msg);
      this.syncModals();
    }
  }

  updateJoinURLs() {
    let playUrl;
    if (this.tunnelUrl) {
      playUrl = `${this.tunnelUrl}/play`;
    } else if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      playUrl = `${window.location.protocol}//${window.location.host}/play`;
    } else {
      playUrl = `${window.location.protocol}//${this.lanIp}:${this.port}/play`;
    }

    document.getElementById('lobby-url-display').textContent = playUrl;
    document.getElementById('sidebar-url-text').textContent = playUrl;

    if (window.QRCode) {
      document.getElementById('lobby-qr-svg').innerHTML = QRCode.generateSVG(playUrl, 200);
      document.getElementById('qr-mini').innerHTML = QRCode.generateSVG(playUrl, 44);
    }
  }

  updateHUD(msg) {
    const totalSec = Math.max(0, Math.floor(this.timer));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    this.timerDisplay.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    if (totalSec <= 15 && this.phase === 'PLAYING') {
      this.timerDisplay.classList.add('timer-urgent');
    } else {
      this.timerDisplay.classList.remove('timer-urgent');
    }

    // Phase Badge
    this.phaseBadge.className = 'phase-badge';
    if (this.phase === 'LOBBY') {
      this.phaseBadge.textContent = 'SALE STARTS SOON';
      this.phaseBadge.classList.add('phase-lobby');
    } else if (this.phase === 'PLAYING') {
      this.phaseBadge.textContent = '🔥 SALE ENDS IN';
      this.phaseBadge.classList.add('phase-racing');
    } else if (this.phase === 'OVER') {
      this.phaseBadge.textContent = 'SALE ENDED';
      this.phaseBadge.classList.add('phase-over');
    }

    // Players count
    this.playerCountEl.textContent = msg.total_players || 0;
    this.lobbyCountNum.textContent = msg.total_players || 0;
    this.finishedTag.textContent = `${msg.finished_count || 0} Delivered`;

    // Leaderboard
    if (msg.leaderboard && msg.leaderboard.length > 0) {
      this.leaderboardList.innerHTML = msg.leaderboard.map((p, idx) => `
        <div class="lb-row" style="border-left-color: ${p.color};">
          <span class="lb-rank">#${idx + 1}</span>
          <span class="lb-dot" style="background: ${p.color};"></span>
          <span class="lb-name" title="${PERK_LABELS[p.perk] || ''}">${escapeHtml(p.name)} ${PERK_EMOJI[p.perk] || ''}</span>
          ${p.finished
            ? `<span class="lb-progress lb-finished">🏠 DELIVERED</span>`
            : `<span class="lb-progress">${p.progress}%</span>`}
          <span class="lb-savings" title="Coupon savings">$${p.savings || 0}</span>
          <span class="lb-warps" title="Times rerouted by Customs">📦${p.warps}</span>
        </div>
      `).join('');
    }

    // Ticker
    if (msg.ticker) {
      this.tickerFeed.textContent = msg.ticker;
    } else if (msg.events && msg.events.length > 0) {
      this.tickerFeed.textContent = msg.events[msg.events.length - 1].text;
    }

    // Victory Podium populate
    if (this.phase === 'OVER' && msg.podium) {
      if (msg.podium.length === 0) {
        document.getElementById('champ-banner').textContent = 'SALE OVER: NO DELIVERIES!';
        document.getElementById('champ-sub').textContent = 'Every parcel is still stuck in the aisles. Try again!';
        document.getElementById('podium-cards').innerHTML = '';
      } else {
        const champ = msg.podium[0];
        document.getElementById('champ-banner').textContent = `${champ.name.toUpperCase()} DELIVERED FIRST!`;
        document.getElementById('champ-sub').textContent = `Dodged customs and reached the door in ${champ.time}s with $${champ.savings || 0} in coupons!`;

        const podiumHtml = msg.podium.slice(0, 3).map((p, idx) => `
          <div class="podium-box">
            <div class="podium-rank rank-${idx + 1}">#${idx + 1}</div>
            <div class="podium-name"><span class="lb-dot" style="display:inline-block;background:${p.color};"></span> ${escapeHtml(p.name)}</div>
            <div class="podium-time">${p.time}s</div>
            <div class="podium-meta">💸 $${p.savings || 0} saved • 📦 ${p.warps} reroutes</div>
          </div>
        `).join('');
        document.getElementById('podium-cards').innerHTML = podiumHtml;
      }

      // Lost Parcel Award (most reroutes) & Bargain Hunter (most savings)
      if (this.balls && this.balls.length > 0) {
        const mostWarped = [...this.balls].sort((a, b) => b[5] - a[5])[0];
        if (mostWarped && mostWarped[5] > 0) {
          document.getElementById('award-text').textContent = `${mostWarped[6]} got rerouted ${mostWarped[5]} times!`;
        }
        const bargain = [...this.balls].sort((a, b) => (b[7] || 0) - (a[7] || 0))[0];
        if (bargain && bargain[7] > 0) {
          document.getElementById('bargain-text').textContent = `${bargain[6]} saved $${bargain[7]} in coupons!`;
        }
      }
    }
  }

  syncModals() {
    if (this.phase === 'LOBBY') {
      this.lobbyModal.style.display = 'flex';
      this.victoryModal.style.display = 'none';
      document.getElementById('btn-start-match').style.display = 'block';
      document.getElementById('btn-reset-match').style.display = 'none';
    } else if (this.phase === 'PLAYING') {
      this.lobbyModal.style.display = 'none';
      this.victoryModal.style.display = 'none';
      document.getElementById('btn-start-match').style.display = 'none';
      document.getElementById('btn-reset-match').style.display = 'block';
    } else if (this.phase === 'OVER') {
      this.lobbyModal.style.display = 'none';
      this.victoryModal.style.display = 'flex';
      document.getElementById('btn-start-match').style.display = 'none';
      document.getElementById('btn-reset-match').style.display = 'block';
    }
  }

  startRace() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      window.sfx.init();
      if (window.music) window.music.init();
      if (window.announcer) window.announcer.initVoice();
      this.ws.send(JSON.stringify({ type: 'host_start' }));
    }
  }

  resetRace() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (window.music) window.music.stop();
      if (window.announcer && window.announcer.synth) window.announcer.synth.cancel();
      this.ws.send(JSON.stringify({ type: 'host_reset' }));
    }
  }

  // --------------------------------------------------------------------------
  // Particle & FX Generation
  // --------------------------------------------------------------------------
  spawnWarpSparks(x, y) {
    const scale = this.canvasSize / this.gridW;
    const px = x * scale;
    const py = y * scale;

    for (let i = 0; i < 22; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = Math.random() * 4 + 1.5;
      this.particles.push({
        x: px, y: py,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: Math.random() * 3 + 1.5,
        color: '#E02020',
        alpha: 1.0,
        decay: 0.06, // Quick snappy fade
      });
    }
  }

  spawnGoalFireworks(x, y) {
    const scale = this.canvasSize / this.gridW;
    const px = x * scale;
    const py = y * scale;

    for (let i = 0; i < 30; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = Math.random() * 5 + 2;
      this.particles.push({
        x: px, y: py,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd,
        size: Math.random() * 3.5 + 2,
        color: i % 2 ? '#12A150' : '#FB7701',
        alpha: 1.0,
        decay: 0.05,
      });
    }
  }

  addLocator(id, name, from) {
    const now = performance.now();
    this.locators.set(id, { start: now, until: now + 3200, from, name });
  }

  // Highlights real players after a reroute (or when they tap FIND ME):
  // a dashed trail from the hold they fell into, plus a pulsing ring + name pill
  renderLocators(ctx, scale, nowMs) {
    if (this.locators.size === 0) return;
    const byId = new Map();
    for (const b of this.balls) byId.set(b[0], b);

    for (const [id, loc] of this.locators) {
      const b = byId.get(id);
      if (!b || nowMs > loc.until) { this.locators.delete(id); continue; }
      const t = (nowMs - loc.start) / (loc.until - loc.start);   // 0..1
      const fade = t > 0.75 ? (1 - t) / 0.25 : 1;
      const color = BALL_COLORS[b[3]] || '#FB7701';
      const bx = b[1] * scale;
      const by = b[2] * scale;

      ctx.save();
      ctx.globalAlpha = fade;

      // Dim the rest of the board briefly so the eye jumps to the parcel
      if (t < 0.35) {
        ctx.fillStyle = `rgba(31, 26, 23, ${0.18 * (1 - t / 0.35)})`;
        ctx.fillRect(0, 0, this.canvasSize, this.canvasSize);
      }

      // Trail from the hold they fell into
      if (loc.from) {
        const fx = loc.from[0] * scale;
        const fy = loc.from[1] * scale;
        const mx = (fx + bx) / 2;
        const my = (fy + by) / 2 - Math.hypot(bx - fx, by - fy) * 0.25;
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 6]);
        ctx.lineDashOffset = -nowMs * 0.05;
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.quadraticCurveTo(mx, my, bx, by);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Shrinking "target" rings that converge on the parcel
      for (let k = 0; k < 2; k++) {
        const phase = ((nowMs / 700) + k * 0.5) % 1;
        const r = scale * (2.6 - phase * 1.9);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.globalAlpha = fade * phase;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = fade;
      ctx.strokeStyle = '#1F1A17';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, scale * 0.6, 0, Math.PI * 2);
      ctx.stroke();

      // Name pill with a pointer
      const label = `📍 ${b[6]}`;
      ctx.font = `900 ${Math.max(11, scale * 0.5)}px Outfit, sans-serif`;
      const tw = ctx.measureText(label).width;
      const ph = Math.max(18, scale * 0.8);
      const px = Math.min(Math.max(bx, tw / 2 + 8), this.canvasSize - tw / 2 - 8);
      const py = by - scale * 1.1 - ph < 4 ? by + scale * 1.1 : by - scale * 1.1 - ph;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(px - tw / 2 - 8, py, tw + 16, ph, ph / 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px, py + ph / 2 + 1);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
    }
  }

  spawnCouponBurst(x, y, value) {
    const scale = this.canvasSize / this.gridW;
    const n = value >= 10 ? 16 : 6;
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const spd = Math.random() * 2 + 1;
      this.particles.push({
        x: x * scale, y: y * scale,
        vx: Math.cos(angle) * spd,
        vy: Math.sin(angle) * spd - 1,
        size: Math.random() * 2 + 1.5,
        color: value >= 10 ? '#E02020' : '#12A150',
        alpha: 1.0,
        decay: 0.05,
      });
    }
  }

  triggerConfetti() {
    this.confetti = [];
    const colors = ['#FB7701', '#FF8F1F', '#E02020', '#12A150', '#FFB300', '#1E88E5', '#ffffff'];
    const w = window.innerWidth;
    for (let i = 0; i < 150; i++) {
      this.confetti.push({
        x: Math.random() * w,
        y: -Math.random() * 200,
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 4 + 3,
        size: Math.random() * 10 + 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360,
        rSpeed: (Math.random() - 0.5) * 8,
      });
    }
  }

  // --------------------------------------------------------------------------
  // 60 FPS Render Loop
  // --------------------------------------------------------------------------
  renderLoop(time) {
    this.renderMaze(time);
    this.renderParticles();
    this.renderConfetti();

    requestAnimationFrame(this.renderLoop.bind(this));
  }

  renderMaze(time) {
    if (!this.maze) return;
    const ctx = this.mazeCtx;
    const size = this.canvasSize;
    const scale = size / this.gridW;
    const nowSec = time * 0.001;

    ctx.clearRect(0, 0, size, size);

    // 1. Warehouse floor + orange shelving walls
    ctx.fillStyle = '#FFF8F2';
    ctx.fillRect(0, 0, size, size);
    for (let r = 0; r < this.gridH; r++) {
      for (let c = 0; c < this.gridW; c++) {
        const x = c * scale;
        const y = r * scale;
        if (this.maze[r][c] === 1) {
          ctx.fillStyle = '#FB7701';
          ctx.fillRect(x, y, scale + 0.5, scale + 0.5);
        } else if ((r + c) % 2 === 0) {
          ctx.fillStyle = '#FFF1E5';
          ctx.fillRect(x, y, scale, scale);
        }
      }
    }
    // Shelf edge shading where walls meet the floor (gives the aisles depth)
    ctx.fillStyle = '#D95F00';
    for (let r = 0; r < this.gridH - 1; r++) {
      for (let c = 0; c < this.gridW; c++) {
        if (this.maze[r][c] === 1 && this.maze[r + 1][c] === 0) {
          ctx.fillRect(c * scale, (r + 1) * scale - scale * 0.18, scale + 0.5, scale * 0.18);
        }
      }
    }

    // 2. Warehouse (start room)
    const sx = (this.startPos[0] - 1.5) * scale;
    const sy = (this.startPos[1] - 1.5) * scale;
    ctx.fillStyle = 'rgba(38, 50, 56, 0.08)';
    ctx.fillRect(sx, sy, scale * 3, scale * 3);
    ctx.strokeStyle = '#263238';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(sx + 1, sy + 1, scale * 3 - 2, scale * 3 - 2);
    ctx.setLineDash([]);
    ctx.fillStyle = '#263238';
    ctx.font = `900 ${Math.max(9, scale * 0.42)}px Outfit, sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('📦 WAREHOUSE', sx + 4, sy + scale * 0.6);

    // 3. Customer's door (finish)
    const gx = this.goalPos[0] * scale;
    const gy = this.goalPos[1] * scale;
    const pulse = 0.5 + 0.5 * Math.sin(nowSec * 4);
    ctx.fillStyle = `rgba(18, 161, 80, ${0.12 + pulse * 0.1})`;
    ctx.beginPath();
    ctx.arc(gx, gy, 1.25 * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#12A150';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.font = `${scale * 1.2}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏠', gx, gy);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#12A150';
    ctx.font = `900 ${Math.max(9, scale * 0.42)}px Outfit, sans-serif`;
    ctx.fillText('DELIVERED', gx, gy - 1.35 * scale);

    // 4. Coupons (bobbing price tags)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.coupons.length; i++) {
      const [cx0, cy0, val] = this.coupons[i];
      const cx = cx0 * scale;
      const cy = cy0 * scale + Math.sin(nowSec * 3 + i) * scale * 0.06;
      const w = scale * (val >= 10 ? 0.8 : 0.66);
      const h = scale * 0.42;
      ctx.fillStyle = val >= 10 ? '#E02020' : '#12A150';
      ctx.beginPath();
      ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h * 0.3);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `900 ${h * 0.72}px Outfit, sans-serif`;
      ctx.fillText(`$${val}`, cx, cy + 0.5);
    }
    ctx.textBaseline = 'alphabetic';

    // 5. Customs Holds (pulsing gravity traps)
    this.redHoles.forEach((hole, idx) => {
      const hx = hole.x * scale;
      const hy = hole.y * scale;
      const liveRad = this.holeRadii[idx] ?? 0.75;

      ctx.save();
      ctx.translate(hx, hy);

      // Closed: dashed outline so players can see where it will reopen
      if (liveRad < 0.08) {
        ctx.strokeStyle = 'rgba(224, 32, 32, 0.45)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(0, 0, 0.42 * scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return;
      }
      const hRad = liveRad * scale;
      const openness = liveRad / 0.75;

      // Gravity field
      ctx.fillStyle = `rgba(224, 32, 32, ${0.06 + 0.1 * openness})`;
      ctx.beginPath();
      ctx.arc(0, 0, 2.2 * scale, 0, Math.PI * 2);
      ctx.fill();

      // Trap body
      const grad = ctx.createRadialGradient(0, 0, 1, 0, 0, hRad);
      grad.addColorStop(0, '#5A0000');
      grad.addColorStop(0.65, '#B00000');
      grad.addColorStop(1, '#E02020');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, hRad, 0, Math.PI * 2);
      ctx.fill();

      // Spinning spiral
      ctx.rotate(-nowSec * 3 + idx);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 2; a += 0.2) {
        const r = (a / (Math.PI * 2)) * hRad * 0.9;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // "HOLD" sticker when wide open
      if (openness > 0.7) {
        ctx.fillStyle = '#fff';
        ctx.font = `900 ${Math.max(8, scale * 0.3)}px Outfit, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('HOLD', hx, hy - hRad - 3);
      }
    });

    // 6. Parcels: [id, x, y, color_idx, finished, warps, name, savings]
    const half = 0.3 * scale;
    // Draw back-to-front: real players come first in the list, so they end up on top of bots
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];
      const bx = b[1] * scale;
      const by = b[2] * scale;
      const color = BALL_COLORS[b[3]] || BALL_COLORS[0];
      const isFinished = b[4] === 1;

      ctx.save();
      ctx.globalAlpha = isFinished ? 0.55 : 1;
      // Box body with dark outline so every colour reads on the light floor
      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(bx - half, by - half, half * 2, half * 2, half * 0.3);
      ctx.fill();
      ctx.stroke();
      // Packing tape
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.fillRect(bx - half * 0.18, by - half, half * 0.36, half * 2);

      if (isFinished) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#12A150';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bx, by, half * 1.6, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Name tags: real players always get a pill; bots only when the warehouse is quiet
      if (b[8] === 1 && !this.locators.has(b[0])) {
        ctx.font = 'bold 10px Outfit, sans-serif';
        const tw = ctx.measureText(b[6] || '').width;
        ctx.fillStyle = 'rgba(31, 26, 23, 0.85)';
        ctx.beginPath();
        ctx.roundRect(bx - tw / 2 - 4, by - half - 15, tw + 8, 13, 6);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(b[6] || '', bx, by - half - 5);
      } else if (this.balls.length <= 40) {
        ctx.fillStyle = '#1F1A17';
        ctx.font = 'bold 9px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(b[6] || '', bx, by - half - 3);
      }
      ctx.restore();
    }

    // 7. Locator highlights for real players (after reroutes / FIND ME)
    this.renderLocators(ctx, scale, time);
  }

  renderParticles() {
    const ctx = this.fxCtx;
    ctx.clearRect(0, 0, this.canvasSize, this.canvasSize);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.alpha -= (p.decay || 0.05);

      if (p.alpha <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1.0;
  }

  renderConfetti() {
    if (this.confetti.length === 0) return;
    const ctx = this.confettiCtx;
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < this.confetti.length; i++) {
      const c = this.confetti[i];
      c.x += c.vx;
      c.y += c.vy;
      c.rotation += c.rSpeed;

      if (c.y > h) {
        c.y = -20;
        c.x = Math.random() * w;
      }

      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate((c.rotation * Math.PI) / 180);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.size / 2, -c.size / 2, c.size, c.size * 0.6);
      ctx.restore();
    }
  }
}

const PERK_EMOJI = { express: '🚚', insured: '🛡️', magnet: '🧲', none: '' };
const PERK_LABELS = { express: 'Express Shipping', insured: 'Insured Parcel', magnet: 'Coupon Magnet', none: '' };

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// Global Bot Helper Functions for Dialog
window.setBotCount = function(count) {
  if (window.hostCtrl && window.hostCtrl.ws) {
    window.hostCtrl.ws.send(JSON.stringify({ type: 'host_set_bots', count: count }));
    document.getElementById('bot-count-tag').textContent = `(${count})`;
  }
};

window.clearBots = function() {
  if (window.hostCtrl && window.hostCtrl.ws) {
    window.hostCtrl.ws.send(JSON.stringify({ type: 'host_clear_bots' }));
    document.getElementById('bot-count-tag').textContent = `(0)`;
  }
};

window.toggleBotDialog = function() {
  const dlg = document.getElementById('bot-dialog');
  dlg.style.display = (dlg.style.display === 'none' || dlg.style.display === '') ? 'block' : 'none';
};

window.addEventListener('DOMContentLoaded', () => {
  window.hostCtrl = new HostController();
});
