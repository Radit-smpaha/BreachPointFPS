// BREACHPOINT — procedural audio (no sample files: everything is synthesised, so it loads instantly)
export class Audio {
  constructor() {
    this.ctx = null; this.master = null; this.musicGain = null; this.sfxGain = null;
    this.enabled = true; this.volume = 0.8; this.musicOn = true; this._musicTimer = null;
    this.listenerPos = { x: 0, z: 0 }; this.listenerYaw = 0;
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(this.ctx.destination);
    // gentle limiter so explosions don't clip
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 22; comp.ratio.value = 7; comp.attack.value = 0.003; comp.release.value = 0.22;
    comp.connect(this.master);
    this.bus = comp;
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.9; this.sfxGain.connect(comp);
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.22; this.musicGain.connect(comp);
    this.noiseBuf = this._makeNoise(2.5);
  }
  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
  _makeNoise(sec) {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const b = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  _pan(pos) {
    if (!pos) return null;
    const dx = pos.x - this.listenerPos.x, dz = pos.z - this.listenerPos.z;
    const d = Math.hypot(dx, dz);
    // relative angle vs. listener facing (camera looks down -Z at yaw 0)
    const a = Math.atan2(dx, dz) - (this.listenerYaw + Math.PI);
    let p = Math.sin(a);
    const pn = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (pn) { pn.pan.value = Math.max(-0.9, Math.min(0.9, p)); pn.connect(this.sfxGain); }
    return { node: pn || this.sfxGain, dist: d };
  }
  _volFor(dist, near = 6, far = 48) {
    if (dist == null) return 1;
    return Math.max(0, 1 - (dist - near) / (far - near)) ** 1.6;
  }
  _noise(dur, { type = 'lowpass', freq = 1200, q = 1, gain = 0.5, decay = 0.05, attack = 0.001, pan = null, bus = null } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + decay);
    src.connect(f); f.connect(g); g.connect(pan ? pan.node : (bus || this.sfxGain));
    src.start(t); src.stop(t + dur + decay + 0.02);
  }
  _tone(f0, f1, dur, { type = 'sine', gain = 0.2, decay = 0.1, attack = 0.002, pan = null } = {}) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + decay);
    o.connect(g); g.connect(pan ? pan.node : this.sfxGain);
    o.start(t); o.stop(t + dur + decay + 0.02);
  }

  // ---------- weapons ----------
  shot(kind, pos = null) {
    if (!this.ctx) return;
    const p = pos ? this._pan(pos) : null;
    const v = p ? this._volFor(p.dist) : 1;
    if (v <= 0.01) return;
    const cfg = {
      rifle: { freq: 2600, tone: [150, 55], dur: 0.11, g: 0.9 },
      smg: { freq: 3200, tone: [220, 90], dur: 0.07, g: 0.6 },
      shotgun: { freq: 1500, tone: [90, 38], dur: 0.26, g: 1.0 },
      sniper: { freq: 1900, tone: [110, 32], dur: 0.34, g: 1.0 },
      pistol: { freq: 2800, tone: [200, 70], dur: 0.09, g: 0.7 },
      enemy: { freq: 2200, tone: [160, 60], dur: 0.1, g: 0.55 },
    }[kind] || { freq: 2400, tone: [150, 60], dur: 0.1, g: 0.7 };
    this._noise(0.02, { type: 'highpass', freq: cfg.freq, gain: cfg.g * v * 0.7, decay: cfg.dur, pan: p });
    this._tone(cfg.tone[0], cfg.tone[1], cfg.dur * 0.7, { type: 'triangle', gain: cfg.g * 0.5 * v, decay: cfg.dur, pan: p });
    this._noise(cfg.dur, { type: 'lowpass', freq: 700, gain: cfg.g * 0.35 * v, decay: cfg.dur, pan: p });
  }
  dryFire() { this._tone(1800, 900, 0.02, { type: 'square', gain: 0.08, decay: 0.02 }); }
  reload(inOut) { this._noise(0.05, { type: 'bandpass', freq: inOut ? 1800 : 1200, q: 6, gain: 0.25, decay: 0.05 }); }
  hitmarker(head) {
    this._tone(head ? 1500 : 1050, head ? 900 : 700, 0.03, { type: 'sine', gain: 0.14, decay: 0.02 });
    if (head) this._tone(2400, 1800, 0.05, { type: 'sine', gain: 0.06, decay: 0.03 });
  }
  kill() { this._tone(600, 300, 0.12, { type: 'triangle', gain: 0.12, decay: 0.1 }); }
  impact(pos) { const p = this._pan(pos); const v = this._volFor(p.dist, 2, 26); if (v > 0) this._noise(0.03, { type: 'bandpass', freq: 2400, q: 2, gain: 0.16 * v, decay: 0.04, pan: p }); }
  whiz(pos) { const p = this._pan(pos); this._noise(0.06, { type: 'bandpass', freq: 3200, q: 9, gain: 0.2, decay: 0.05, pan: p }); this._tone(2600, 1400, 0.07, { type: 'sine', gain: 0.05, decay: 0.05, pan: p }); }
  explosion(pos) {
    const p = this._pan(pos); const v = pos ? Math.max(0.25, this._volFor(p.dist, 4, 70)) : 1;
    this._noise(0.5, { type: 'lowpass', freq: 420, gain: 1.0 * v, decay: 0.9, pan: p });
    this._tone(90, 26, 0.7, { type: 'sine', gain: 0.8 * v, decay: 0.6, pan: p });
    this._noise(0.1, { type: 'highpass', freq: 2000, gain: 0.25 * v, decay: 0.2, pan: p });
  }
  grenadeBounce(pos) { const p = this._pan(pos); this._tone(900, 500, 0.05, { type: 'square', gain: 0.06, decay: 0.04, pan: p }); }
  pin() { this._tone(2000, 1400, 0.04, { type: 'square', gain: 0.07, decay: 0.03 }); }
  step(running) {
    this._noise(0.03, { type: 'lowpass', freq: running ? 900 : 600, gain: running ? 0.09 : 0.055, decay: 0.06 });
  }
  land(hard) { this._noise(0.08, { type: 'lowpass', freq: 300, gain: hard ? 0.35 : 0.15, decay: 0.12 }); }
  hurt() { this._tone(300, 120, 0.18, { type: 'sawtooth', gain: 0.18, decay: 0.15 }); this._noise(0.1, { type: 'lowpass', freq: 500, gain: 0.25, decay: 0.15 }); }
  pickup() { this._tone(700, 1100, 0.08, { type: 'sine', gain: 0.1, decay: 0.06 }); this._tone(1100, 1500, 0.09, { type: 'sine', gain: 0.07, decay: 0.08 }); }
  ui(kind = 'hover') {
    if (!this.ctx) return;
    if (kind === 'hover') this._tone(1300, 1300, 0.02, { type: 'sine', gain: 0.035, decay: 0.02 });
    else if (kind === 'click') { this._tone(520, 780, 0.06, { type: 'triangle', gain: 0.12, decay: 0.05 }); this._noise(0.03, { type: 'highpass', freq: 3000, gain: 0.08, decay: 0.03 }); }
    else if (kind === 'back') this._tone(700, 380, 0.08, { type: 'triangle', gain: 0.1, decay: 0.06 });
    else if (kind === 'deny') this._tone(220, 180, 0.15, { type: 'square', gain: 0.08, decay: 0.1 });
  }
  objective(ok) {
    if (ok) { [523, 659, 784].forEach((f, i) => setTimeout(() => this._tone(f, f, 0.18, { type: 'triangle', gain: 0.12, decay: 0.2 }), i * 110)); }
    else { this._tone(300, 200, 0.3, { type: 'sawtooth', gain: 0.14, decay: 0.3 }); }
  }
  callout(pos) { const p = this._pan(pos); this._tone(520, 460, 0.09, { type: 'square', gain: 0.05, decay: 0.06, pan: p }); }

  // ---------- menu ambience: slow cinematic drones + pulse ----------
  startMusic() {
    if (!this.ctx || this._musicTimer || !this.musicOn) return;
    const ctx = this.ctx;
    const pad = ctx.createGain(); pad.gain.value = 0; pad.connect(this.musicGain);
    pad.gain.linearRampToValueAtTime(1, ctx.currentTime + 3);
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 480; filt.Q.value = 1.2; filt.connect(pad);
    const notes = [55, 82.4, 110, 130.8, 164.8];
    this._pads = notes.map((f, i) => {
      const o = ctx.createOscillator(); o.type = i % 2 ? 'sawtooth' : 'sine'; o.frequency.value = f;
      o.detune.value = (i - 2) * 6;
      const g = ctx.createGain(); g.gain.value = 0.16 / (i + 1);
      o.connect(g); g.connect(filt); o.start();
      return o;
    });
    this._padNode = pad; this._padFilter = filt;
    const beat = () => {
      if (!this.musicOn) return;
      const t = ctx.currentTime;
      // low heartbeat thump
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g); g.connect(this.musicGain); o.start(t); o.stop(t + 0.55);
      // sparse tick texture
      if (Math.random() < 0.6) {
        const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
        const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2600 + Math.random() * 1800; nf.Q.value = 12;
        const ng = ctx.createGain(); ng.gain.setValueAtTime(0.06, t); ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
        n.connect(nf); nf.connect(ng); ng.connect(this.musicGain); n.start(t); n.stop(t + 0.15);
      }
      this._musicTimer = setTimeout(beat, 760);
    };
    beat();
  }
  stopMusic() {
    if (this._musicTimer) clearTimeout(this._musicTimer);
    this._musicTimer = null;
    if (this._padNode) {
      const t = this.ctx.currentTime;
      this._padNode.gain.cancelScheduledValues(t);
      this._padNode.gain.setValueAtTime(this._padNode.gain.value, t);
      this._padNode.gain.linearRampToValueAtTime(0, t + 0.8);
      const olds = this._pads; setTimeout(() => olds?.forEach(o => o.stop()), 1000);
    }
    this._padNode = null; this._pads = null;
  }
  setCombatMusic(on) {
    if (!this.ctx || !this._padFilter) return;
    this._padFilter.frequency.linearRampToValueAtTime(on ? 1400 : 480, this.ctx.currentTime + 1.2);
  }
}
