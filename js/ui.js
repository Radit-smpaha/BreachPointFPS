// BREACHPOINT — interface controller: screens, menus, armory preview, HUD binding
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { WEAPONS, SHOP_ITEMS } from './weapons.js';
import { MAPS } from './level.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

export class UI {
  constructor(game) {
    this.game = game;
    this.screen = 'boot';
    this.selectedMap = 'factory';
    this.mode = 'breach';
    this.diff = 'operator';
    this.gunPreview = null;
    this.rebindAction = null;
    this._rebindListener = null;
    this.buildMapCards();
    this.buildArmory();
    this.buildSettings();
    this.buildShop();
    this.bindNav();
    this.bindHud();
    this.bindKeybinds();
  }

  /* ---------------- screen routing ---------------- */
  show(name) {
    for (const s of $$('.screen')) s.classList.remove('active');
    if (name === null) { this.screen = null; $('#hud').classList.remove('hidden'); return; }
    $('#hud').classList.add('hidden');
    document.getElementById('hud').style.opacity = '1';
    const el = $('#screen-' + name);
    if (el) el.classList.add('active');
    this.screen = name;
    if (name === 'loadout') this.showArmory();
    if (name === 'intel') this.refreshKeybinds();
    if (name === 'shop') this.showShop();
  }
  hideAll() { for (const s of $$('.screen')) s.classList.remove('active'); this.screen = null; }
  bindNav() {
    $$('[data-screen]').forEach(b => {
      b.addEventListener('click', () => {
        const to = b.dataset.screen;
        this.game.audio.ui(to === 'menu' ? 'back' : 'click');
        this.show(to === 'menu' && this.game.mode === 'paused' ? 'pause' : to);
      });
      b.addEventListener('mouseenter', () => this.game.audio.ui('hover'));
    });
    // stage dots switch the menu backdrop's map
    $$('.stage-dot').forEach(d => d.addEventListener('click', () => {
      this.setMenuMap(d.dataset.map);
      this.game.audio.ui('click');
    }));
    $('#boot-enter').addEventListener('click', () => this.game.enterFromBoot());
    $$('.seg button').forEach(b => b.addEventListener('click', () => {
      const parent = b.parentElement;
      parent.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      this.game.audio.ui('click');
      if (parent.id === 'seg-mode') this.mode = b.dataset.mode;
      if (parent.id === 'seg-diff') { this.diff = b.dataset.diff; }
    }));
    $('#btn-launch').addEventListener('click', () => { this.game.audio.ui('click'); this.game.startGame(this.selectedMap, this.mode, this.diff); });
    $('#btn-resume').addEventListener('click', () => this.game.resume());
    $('#btn-restart').addEventListener('click', () => this.game.restart());
    $('#btn-abort').addEventListener('click', () => this.game.abortToMenu());
    $('#btn-pause-settings').addEventListener('click', () => this.game.openPauseSettings());
    $('#btn-debrief-menu').addEventListener('click', () => this.game.abortToMenu());
    $('#btn-redeploy').addEventListener('click', () => this.game.restart());
    $$('.mrow,.cta,.ghost-btn').forEach(b => b.addEventListener('mouseenter', () => this.game.audio.ui('hover')));
    // keyboard on menu
    window.addEventListener('keydown', (e) => {
      if (this.screen === 'menu') {
        if (['1', '2', '3', '4'].includes(e.key)) {
          const map = { 1: 'play', 2: 'loadout', 3: 'settings', 4: 'intel' };
          this.game.audio.ui('click'); this.show(map[e.key]);
        }
      }
    });
  }

  setMenuMap(id) {
    this.selectedMap = id;
    $$('.stage-dot').forEach(d => d.classList.toggle('active', d.dataset.map === id));
    const m = MAPS[id];
    $('#cap-map').textContent = m.name;
    $('#cap-map-sub').textContent = `${m.sub} · ${m.hostiles} hostile signatures`;
    $$('.map-card').forEach(c => c.classList.toggle('sel', c.dataset.map === id));
    this.game.setMenuBackdrop(id);
  }

  /* ---------------- map cards with live mini 3D previews ---------------- */
  buildMapCards() {
    const grid = $('#map-grid');
    Object.values(MAPS).forEach((m, i) => {
      const card = document.createElement('button');
      card.className = 'map-card' + (m.id === this.selectedMap ? ' sel' : '');
      card.dataset.map = m.id;
      card.innerHTML = `
        <canvas></canvas><div class="mc-grad"></div>
        <span class="mc-idx">${m.code}</span>
        <div class="mc-body">
          <h3>${m.title}</h3>
          <p class="mc-sub">${m.sub}</p>
          <div class="mc-tags">${m.tags.map(t => `<span>${t}</span>`).join('')}</div>
        </div>`;
      card.addEventListener('click', () => { this.setMenuMap(m.id); this.game.audio.ui('click'); });
      card.addEventListener('mouseenter', () => this.game.audio.ui('hover'));
      grid.appendChild(card);
      this.renderMapPreview(card.querySelector('canvas'), m);
    });
  }
  /** paints an isometric top-down of the map from its GLB + collider data */
  async renderMapPreview(canvas, def) {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(320, Math.floor(rect.width * 1.5)) || 480;
    canvas.height = Math.max(200, Math.floor(rect.height * 1.5)) || 340;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(1);
    renderer.setSize(canvas.width, canvas.height, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(40, canvas.width / canvas.height, 1, 500);
    scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x221a12, 1.3));
    const dir = new THREE.DirectionalLight(0xffd9a0, 1.8); dir.position.set(30, 60, 20); scene.add(dir);
    const accent = new THREE.Color(def.accent);
    const grd = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: 0x08090a }));
    grd.rotation.x = -Math.PI / 2; grd.position.y = -0.5; scene.add(grd);
    try {
      const gltf = await new GLTFLoader().loadAsync('./assets/maps/' + def.file);
      const root = gltf.scene;
      // flatten to flat-shaded silhouettes for a "tactical model" look
      root.traverse(o => {
        if (!o.isMesh) return;
        const g = o.geometry;
        const mat = new THREE.MeshStandardMaterial({ color: accent.clone().multiplyScalar(0.4).offsetHSL(0, -0.2, 0.06), flatShading: true, roughness: 0.9, metalness: 0.05 });
        o.material = mat;
      });
      const box = new THREE.Box3().setFromObject(root);
      const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
      const radius = Math.max(sz.x, sz.z) * 0.5;
      cam.position.set(c.x + radius * 0.9, c.y + radius * 1.15, c.z + radius * 1.1);
      cam.lookAt(c.x, c.y, c.z);
      scene.add(root);
      // faint accent rim light for readability
      const rim = new THREE.DirectionalLight(accent, 2.0); rim.position.set(-40, 30, -50); scene.add(rim);
      cameraFit(cam, radius, sz);
      renderer.render(scene, cam);
      // slow idle drift when hovering, for life
      let raf, t0 = performance.now();
      const loop = (t) => {
        const card = canvas.closest('.map-card');
        if (!card) return;
        if (card.matches(':hover')) {
          const a = (t - t0) * 0.00012;
          cam.position.x = c.x + Math.cos(a) * radius * 1.35;
          cam.position.z = c.z + Math.sin(a) * radius * 1.35;
          cam.lookAt(c.x, c.y, c.z);
          renderer.render(scene, cam);
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    } catch (e) {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#15181a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  /* ---------------- armory ---------------- */
  buildArmory() {
    const prim = ['m4', 'ak', 'mp7', 'super90', 'awm'];
    const sec = ['p226', 'deagle'];
    const mk = (id, container) => {
      const d = WEAPONS[id];
      const el = document.createElement('button');
      el.className = 'gun-card' + (this.game.loadout.primary === id ? ' sel' : '');
      el.dataset.id = id;
      el.innerHTML = `<span class="gc-sil"></span><strong>${d.short}</strong><small>${d.cls}</small>`;
      el.addEventListener('click', () => {
        this.game.audio.ui('click');
        this.game.setLoadout(d.slot, id);
        el.parentElement.querySelectorAll('.gun-card').forEach(x => x.classList.toggle('sel', x.dataset.id === id));
        this.showArmory();
      });
      el.addEventListener('mouseenter', () => this.game.audio.ui('hover'));
      container.appendChild(el);
    };
    prim.forEach(id => mk(id, $('#primaries')));
    sec.forEach(id => mk(id, $('#secondaries')));
  }
  async showArmory() {
    const id = this.game.loadout.primary;
    const d = WEAPONS[id];
    $('#gun-name').textContent = d.name;
    $('#gun-class').textContent = d.cls;
    const sb = $('#gun-stats');
    sb.innerHTML = Object.entries(d.stats).map(([k, v]) => `
      <div class="sb"><span>${k}</span><div class="bar">${Array.from({ length: 10 }, (_, i) => `<i class="${i < v ? 'on' : ''} ${i < v && v >= 8 ? 'hi' : ''}"></i>`).join('')}</div></div>`).join('');
    $('#gun-attrs').innerHTML = Object.entries(d.attrs).map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('') +
      `<div><span>DAMAGE</span><b>${d.dmg}${d.pellets ? ' ×' + d.pellets : ''}</b></div><div><span>RPM</span><b>${d.rpm}</b></div>`;
    this.initGunPreview();
    this.loadGunPreview(id);
  }
  initGunPreview() {
    if (this.gunPreview) return;
    const canvas = $('#gun-canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
    cam.position.set(0, 0, 1.5);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a1512, 2.0));
    const key = new THREE.DirectionalLight(0xffd9a8, 4.0); key.position.set(1.2, 1.6, 1.6); scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 2.6); rim.position.set(-1.6, 0.6, -1.4); scene.add(rim);
    const rim2 = new THREE.DirectionalLight(0xff9a5c, 1.6); rim2.position.set(-1.2, -0.9, 1.0); scene.add(rim2);
    // subtle floor reflection strip
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.2, 32), new THREE.MeshBasicMaterial({ color: 0x0c0e10 }));
    floor.position.y = -0.16; floor.rotation.x = -Math.PI / 2; scene.add(floor);
    this.gunPreview = { renderer, scene, cam, holder: new THREE.Group(), target: null, model: null, yaw: 0.35, pitch: 0.12, dragging: false };
    scene.add(this.gunPreview.holder);
    // drag to rotate
    let px = 0, py = 0;
    canvas.addEventListener('pointerdown', e => { this.gunPreview.dragging = true; px = e.clientX; py = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointerup', e => { this.gunPreview.dragging = false; });
    canvas.addEventListener('pointermove', e => {
      if (!this.gunPreview.dragging) return;
      this.gunPreview.yaw += (e.clientX - px) * 0.01;
      this.gunPreview.pitch = Math.max(-0.6, Math.min(0.8, this.gunPreview.pitch + (e.clientY - py) * 0.006));
      px = e.clientX; py = e.clientY;
    });
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      if (r.width < 10) return;
      renderer.setSize(r.width, r.height, false);
      cam.aspect = r.width / r.height; cam.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.screen !== 'loadout') return;
      resize();
      const gp = this.gunPreview;
      if (!gp.dragging) gp.yaw += 0.0025;
      gp.holder.rotation.set(gp.pitch, gp.yaw, 0);
      gp.holder.position.y = Math.sin(performance.now() * 0.0012) * 0.008;
      renderer.render(scene, cam);
    };
    loop();
  }
  async loadGunPreview(id) {
    const gp = this.gunPreview;
    if (!gp) return;
    $('#gun-preview-cap').textContent = 'LOADING ' + WEAPONS[id].short + '…';
    if (gp.model) { gp.holder.remove(gp.model); gp.model = null; }
    const d = WEAPONS[id];
    try {
      const gltf = await new GLTFLoader().loadAsync('./assets/weapons/' + d.file);
      const obj = gltf.scene;
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
      obj.position.sub(c);
      const maxDim = Math.max(size.x, size.y, size.z);
      const s = 0.62 / maxDim;
      obj.scale.setScalar(s);
      obj.rotation.set(0, 0, 0);
      // materials: keep metal/plastic feel, add environment-less specular
      obj.traverse(o => { if (o.isMesh && o.material) { o.material.envMapIntensity = 1; } });
      gp.holder.add(obj); gp.model = obj;
      $('#gun-preview-cap').textContent = 'DRAG TO ROTATE · ' + d.name;
    } catch (e) { $('#gun-preview-cap').textContent = 'PREVIEW UNAVAILABLE'; }
  }

  /* ---------------- settings ---------------- */
  buildSettings() {
    const g = this.game;
    const grid = $('#settings-grid');
    const group = (title, rows) => {
      const el = document.createElement('div');
      el.className = 'set-group';
      el.innerHTML = `<h4>${title}</h4>` + rows.map(r => r.html).join('');
      grid.appendChild(el);
      rows.forEach((r, i) => r.bind(el));
    };
    const slider = (key, label, min, max, step, get, set, fmt) => ({
      html: `<div class="set-row"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}"><div class="set-val">${fmt(get())}</div></div>`,
      bind(el) {
        const rows = [...el.querySelectorAll('.set-row')];
        const row = rows.find(r => r.querySelector('span').textContent === label);
        const input = row.querySelector('input');
        input.value = get(); row.querySelector('.set-val').textContent = fmt(get());
        input.addEventListener('input', () => { set(parseFloat(input.value)); row.querySelector('.set-val').textContent = fmt(parseFloat(input.value)); });
        input.addEventListener('change', () => g.audio.ui('click'));
      }
    });
    const toggle = (label, get, set) => ({
      html: `<div class="set-row"><span>${label}</span><button class="toggle ${get() ? 'on' : ''}"></button><div class="set-val">${get() ? 'ON' : 'OFF'}</div></div>`,
      bind(el) {
        const row = [...el.querySelectorAll('.set-row')].find(r => r.querySelector('span').textContent === label);
        const btn = row.querySelector('.toggle');
        btn.addEventListener('click', () => { const v = !get(); set(v); btn.classList.toggle('on', v); row.querySelector('.set-val').textContent = v ? 'ON' : 'OFF'; g.audio.ui('click'); });
      }
    });
    const s = g.settings;
    group('INPUT', [
      slider('sens', 'SENSITIVITY', 0.4, 3, 0.05, () => s.sens, v => { s.sens = v; g.save(); }, v => v.toFixed(2) + '×'),
      slider('fov', 'FIELD OF VIEW', 70, 115, 1, () => s.fov, v => { s.fov = v; g.applySettings(); g.save(); }, v => v + '°'),
      toggle('INVERT Y', () => s.invertY, v => { s.invertY = v; g.save(); }),
      toggle('TOGGLE ADS', () => s.toggleAds, v => { s.toggleAds = v; g.save(); }),
      toggle('SCREEN SHAKE', () => s.shake, v => { s.shake = v; g.save(); }),
    ]);
    group('VIDEO', [
      slider('quality', 'RENDER SCALE', 50, 100, 5, () => s.q * 100, v => { s.q = v / 100; g.applySettings(); g.save(); }, v => v + '%'),
      toggle('SHADOWS', () => s.shadows, v => { s.shadows = v; g.applySettings(); g.save(); }),
      toggle('AMBIENT PARTICLES', () => s.particles, v => { s.particles = v; g.save(); }),
      toggle('MOTION BLUR', () => s.motionBlur, v => { s.motionBlur = v; g.save(); }),
      slider('gamma', 'BRIGHTNESS', 0.7, 1.4, 0.05, () => s.gamma, v => { s.gamma = v; g.applySettings(); g.save(); }, v => v.toFixed(2)),
    ]);
    group('AUDIO', [
      slider('vol', 'MASTER VOLUME', 0, 1, 0.05, () => g.audio.volume, v => { g.audio.setVolume(v); s.vol = v; g.save(); }, v => Math.round(v * 100) + '%'),
      toggle('MENU MUSIC', () => g.audio.musicOn, v => { g.audio.musicOn = v; if (v) g.audio.startMusic(); else g.audio.stopMusic(); s.music = v; g.save(); }),
      toggle('HIT SOUNDS', () => s.hitSound, v => { s.hitSound = v; g.save(); }),
    ]);
    group('GAMEPLAY', [
      slider('dmg', 'DAMAGE TAKEN', 0.5, 2, 0.1, () => s.damageTaken, v => { s.damageTaken = v; g.save(); }, v => v.toFixed(1) + '×'),
      toggle('SHOW COMPASS PINGS', () => s.pings, v => { s.pings = v; g.save(); }),
      toggle('LOW HEALTH VIGNETTE', () => s.vignette, v => { s.vignette = v; g.save(); }),
      toggle('BLOOD FX', () => s.blood, v => { s.blood = v; g.save(); }),
    ]);
  }

  /* ---------------- SHOP ---------------- */
  buildShop() {
    const g = this.game; const grid = $('#shop-grid');
    const owned = g.cash.owned || {};
    // Cash is already displayed as #shop-cash in HTML, just update weapon cards
    for (const [id, def] of Object.entries(WEAPONS)) {
      const have = owned[id] || id === 'm4' || id === 'p226';
      const disabled = have || g.cash.amount < def.price;
      const card = document.createElement('div');
      card.className = 'shop-card';
      card.innerHTML = `
        <h4>${def.name}</h4>
        <p>${def.cls} · ${def.attrs.FIRE}</p>
        <p style="font-size:10px;color:var(--bone-dim)">$${def.price}</p>
        ${have ? '<div class="owned">OWNED</div>' : `<button class="buy${disabled ? ' disabled' : ''}" data-id="${id}" data-price="${def.price}" ${disabled ? 'disabled' : ''}>BUY</button>`}
      `;
      grid.appendChild(card);
    }
    grid.addEventListener('click', (e) => {
      const b = e.target.closest('.buy:not(.disabled)');
      if (!b) return;
      const id = b.dataset.id; const price = Number(b.dataset.price);
      if (g.cash.amount >= price && !(g.cash.owned && g.cash.owned[id])) {
        g.cash.amount -= price;
        if (!g.cash.owned) g.cash.owned = {};
        g.cash.owned[id] = true;
        localStorage.setItem('bp_cash', JSON.stringify(g.cash));
        this.showShop();
        g.audio.ui('click');
      }
    });
  }
  showShop() {
    $('#shop-cash').textContent = this.game.cash.amount;
    $$('.shop-card .buy').forEach(b => {
      const id = b.dataset.id; const price = Number(b.dataset.price);
      const have = (this.game.cash.owned || {})[id] || id === 'm4' || id === 'p226';
      b.disabled = have || this.game.cash.amount < price;
      b.textContent = have ? 'OWNED' : `BUY $${price}`;
    });
  }

  /* ---------------- in-game shop (deploy buy menu) ---------------- */
  buildShopGame() {
    const g = this.game; const grid = $('#shop-game-grid');
    grid.innerHTML = '';
    // weapons
    for (const [id, def] of Object.entries(WEAPONS)) {
      const owned = (g.cash.owned || {})[id] || id === 'm4' || id === 'p226';
      const card = document.createElement('div');
      card.className = 'shop-card';
      card.innerHTML = `
        <h4>${def.name}</h4>
        <p>${def.cls} · ${def.attrs.FIRE}</p>
        <p class="price">${owned ? 'OWNED' : '$' + def.price}</p>
        ${owned ? '<div class="owned-badge">EQUIPPED / OWNED</div>' : `<button class="buy${g.cash.amount < def.price ? ' disabled' : ''}" data-id="${id}" data-price="${def.price}" ${g.cash.amount < def.price ? 'disabled' : ''}>BUY</button>`}
      `;
      grid.appendChild(card);
    }
    // shop items (armor + throwables)
    for (const [id, def] of Object.entries(SHOP_ITEMS)) {
      const owned = (g.cash.owned || {})[id];
      const count = def.type === 'throwable' ? (g.throwables[id] || 0) : 0;
      const card = document.createElement('div');
      card.className = 'shop-card';
      const maxOwned = def.type === 'throwable' ? 3 : 1;
      const alreadyOwned = owned || count >= maxOwned;
      card.innerHTML = `
        <h4>${def.name}</h4>
        <p>${def.cls} · ${alreadyOwned ? 'OWNED' : '$' + def.price}</p>
        ${alreadyOwned ? '<div class="owned-badge">EQUIPPED / OWNED</div>' : `<button class="buy${g.cash.amount < def.price ? ' disabled' : ''}" data-id="${id}" data-price="${def.price}" ${g.cash.amount < def.price ? 'disabled' : ''}>BUY</button>`}
      `;
      grid.appendChild(card);
    }
    grid.onclick = (e) => {
      const b = e.target.closest('.buy:not(.disabled)');
      if (!b) return;
      const id = b.dataset.id;
      g.buyWeapon(id);
    };
  }
  setShopGame(open) {
    const el = $('#shop-game');
    el.classList.toggle('hidden', !open);
    this.game.player.alive && (el.style.pointerEvents = open ? 'auto' : 'none');
    if (open) {
      $('#shop-game-cash').textContent = 'CASH $' + this.game.cash.amount;
      this.buildShopGame();
    }
  }
  setWave(wave, count) {
    if (this.hudWave) this.hudWave.textContent = `WAVE ${wave} · ${count}`;
  }
  /* ---------------- HUD ---------------- */
  bindHud() {
    this.hpNum = $('#hp-num'); this.hpArc = $('#hp-arc'); this.armorBar = $('#armor-bar');
    this.mag = $('#ammo-mag'); this.res = $('#ammo-res');
    this.wName = $('#weapon-name'); this.wMode = $('#weapon-mode');
    this.crosshair = $('#crosshair'); this.hitmarker = $('#hitmarker');
    this.objText = $('#obj-text'); this.objSub = $('#obj-sub'); this.objProg = $('#obj-prog');
    // paint the deployed default immediately so the static HTML label never shows
    if (this.objText) this.objText.textContent = 'ELIMINATE THE HOSTILES';
    if (this.objSub) this.objSub.textContent = 'WAVE 1 / 3 · HOSTILES REMAINING';
    this.clock = $('#clock'); this.hostiles = $('#hostiles'); this.hudCash = $('#hud-cash'); this.hudWave = $('#hud-wave');
    this.killfeed = $('#killfeed'); this.notes = $('#notify');
    this.prompt = $('#prompt'); this.promptText = $('#prompt-text');
    this.promptKbd = $('#prompt kbd');
    const shopClose = $('#btn-shop-game-close');
    if (shopClose) shopClose.addEventListener('click', () => { this.game.toggleShop(); });
    this.reloadTrack = $('#reload-track'); this.reloadFill = $('#reload-track i');
    this.hurt = $('#hurt'); this.flash = $('#hit-flash');
    this.hpPrev = 100;
    this.buildCompass();
  }
  bindKeybinds() {
    const g = this.game;
    $$('.keylist kbd[data-action]').forEach(k => {
      k.addEventListener('click', () => this.startRebind(k.dataset.action, k));
    });
  }
  keyDisplay(code) { return this.game.keyName(code); }
  refreshKeybinds() {
    $$('.keylist kbd[data-action]').forEach(k => {
      const action = k.dataset.action;
      k.textContent = this.keyDisplay(this.game.settings.keybinds[action] || k.textContent);
    });
    if (this.promptKbd) this.promptKbd.textContent = this.keyDisplay(this.game.settings.keybinds.interact || 'KeyB');
  }
  startRebind(action, kbdEl) {
    if (this.rebindAction) return;
    this.rebindAction = action;
    kbdEl.textContent = '…';
    kbdEl.classList.add('rebinding');
    const listener = (e) => {
      e.preventDefault();
      if (e.code === 'Escape') { this.cancelRebind(kbdEl); return; }
      if (e.code.startsWith('Key') || e.code.startsWith('Digit') || e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code.startsWith('Control')) {
        this.applyRebind(action, e.code, kbdEl);
      }
    };
    this._rebindListener = listener;
    addEventListener('keydown', listener, { once: true });
  }
  cancelRebind(kbdEl) {
    const action = this.rebindAction;
    this.rebindAction = null;
    kbdEl.classList.remove('rebinding');
    kbdEl.textContent = this.keyDisplay(this.game.settings.keybinds[action] || '');
    removeEventListener('keydown', this._rebindListener);
    this._rebindListener = null;
  }
  applyRebind(action, code, kbdEl) {
    const g = this.game;
    g.settings.keybinds[action] = code;
    g.save();
    this.rebindAction = null;
    kbdEl.classList.remove('rebinding');
    kbdEl.textContent = this.keyDisplay(code);
    removeEventListener('keydown', this._rebindListener);
    this._rebindListener = null;
    this.refreshKeybinds();
    g.audio.ui('click');
    g.note ? g.note(`KEYBOUND: ${action} → ${this.keyDisplay(code)}`) : null;
  }
  buildCompass() {
    const band = $('#compass-band');
    band.innerHTML = '';
    // one full 360 ring, repeated 3x so we can slide without popping
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let rep = 0; rep < 3; rep++) {
      for (let deg = 0; deg < 360; deg += 15) {
        const lab = labels[deg] || '';
        html += `<span class="${lab ? 'card' : ''}">${lab || '·'}<i></i></span>`;
      }
    }
    band.innerHTML = html;
    this.bandCount = 3 * 24;
  }
  setHud(visible) {
    $('#hud').classList.toggle('hidden', !visible);
    if (visible) { const el = $('#hud'); el.style.transition = 'none'; el.style.opacity = '1'; }
  }
  setFps(n) { $('#fps').textContent = n + ' FPS'; }

  updateHud(g) {
    // HUD numbers / HTML rebuilds at 15Hz — the crosshair + compass band stay per-frame
    const now = performance.now();
    if (now < (this._hudNext || 0)) { this._hudDynamic(g); return; }
    this._hudNext = now + 66;
    const p = g.player;
    // health
    const hp = Math.max(0, Math.round(p.hp));
    this.hpNum.textContent = hp;
    const col = hp > 60 ? '#e8e3d7' : hp > 30 ? '#ffb020' : '#ff4a3d';
    this.hpArc.style.strokeDashoffset = 264 * (1 - hp / 100);
    this.hpArc.style.stroke = col;
    this.armorBar.style.height = Math.round(p.armor) + '%';
    this.armorBar.style.background = p.armor > 0 ? 'linear-gradient(0deg,#5b9bd5,#9fd0ff)' : 'transparent';
    this.hurt.style.opacity = g.settings.vignette && hp < 35 ? (1 - hp / 35) * 0.85 : 0;

    // weapon
    const gun = g.guns;
    if (gun.def) {
      this.mag.textContent = gun.cur.mag;
      this.res.textContent = gun.cur.reserve;
      this.mag.classList.toggle('low', gun.cur.mag / gun.def.mag <= 0.25);
      this.wName.textContent = gun.def.name;
      this.wMode.textContent = (gun.def.auto ? 'AUTO' : gun.def.scope ? 'BOLT' : 'SEMI') + ' · ' + gun.def.caliber;
      if (gun.reloading) {
        this.reloadTrack.classList.remove('hidden');
        this.reloadFill.style.width = (gun.reloadT / gun.def.reload * 100) + '%';
      } else this.reloadTrack.classList.add('hidden');
    } else { this.mag.textContent = '0'; this.res.textContent = '0'; }
    $$('#weapon-slots i').forEach((el, i) => el.classList.toggle('on', i === gun.slot));

    this._hudDynamic(g);

    // clock & hostiles
    const t = g.missionTime;
    this.clock.textContent = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(Math.floor(t % 60)).padStart(2, '0');
    this.hostiles.textContent = 'HOSTILES ' + g.enemies.filter(e => !e.dead).length;

    // cash
    if (this.hudCash) this.hudCash.textContent = '$' + g.cash.amount;

    // wave
    if (this.hudWave) {
      if (g.waveCountdownT > 0) {
        this.hudWave.textContent = `WAVE ${g.wave} · ${g.waveEnemyCount}`;
        const wc = $('#wave-countdown');
        const wcn = $('#wc-num');
        wc.style.display = '';
        wcn.textContent = Math.ceil(g.waveCountdownT);
      } else {
        this.hudWave.textContent = `WAVE ${g.wave}${g.waveDefuseUnlocked ? ' · DEFUSE UNLOCKED' : ''} · ${g.waveEnemyCount}`;
        $('#wave-countdown').style.display = 'none';
      }
    }

    // throwables (slot-based: 1/2/3 = slots, left click throws)
    const slot = g.selectedThrowable;
    const thrType = slot >= 0 && g.throwableSlots ? g.throwableSlots[slot] : null;
    const thrCount = thrType && g.throwables ? (g.throwables[thrType] || 0) : 0;
    // OPTIONAL HUD slots: several of these ids are not present in index.html.
    // Writing to a null element used to throw inside updateHud, which crashed
    // updateGame on the FIRST frame and froze the entire game loop (no physics,
    // no camera, no recoil). Every lookup here is now null-safe.
    const on = this._hudEl || (this._hudEl = new Map());
    const el = (sel) => {
      let e = on.get(sel);
      if (e === undefined) { e = $(sel); on.set(sel, e); }
      return e;
    };
    const setText = (sel, v) => { const e = el(sel); if (e) e.textContent = v; };
    const setDisplay = (sel, v) => { const e = el(sel); if (e) e.style.display = v; };
    const toggleCls = (sel, cls, v) => { const e = el(sel); if (e) e.classList.toggle(cls, v); };

    setText('#grenade-count', thrCount);
    setText('#throwable-type', thrType ? `${thrType.replaceAll('_', ' ').toUpperCase()} [${this.keyDisplay(g.settings.keybinds['throwable' + (slot + 1)])}]` : 'THROWABLE [--]');
    toggleCls('#ab-grenade', 'empty', thrCount <= 0);
    toggleCls('#ab-grenade', 'selected', slot >= 0);
    // armor
    const kev = g.playerArmor ? (g.playerArmor.kevlar || 0) : 0;
    const hel = g.playerArmor ? (g.playerArmor.helmet || 0) : 0;
    setText('#kevlar-count', kev);
    setText('#helmet-count', hel);
    setDisplay('#ab-armor', kev > 0 ? '' : 'none');
    setDisplay('#ab-helmet', hel > 0 ? '' : 'none');

    // objective — independent of the bomb nodes: the title follows the wave state,
    // so it reads correctly even on a map with no objectives
    const obj = g.objectives ? g.objectives.find(o => !o.armed) : null;
    const allWavesDown = !!g.waveDefuseUnlocked;
    if (obj) {
      if (allWavesDown) {
        // third (final) wave cleared: the objective switches to the bomb
        this.objText.textContent = 'DEFUSE THE BOMB';
        this.objProg.style.width = '100%';
        const d = Math.hypot(p.pos.x - obj.pos.x, p.pos.z - obj.pos.z);
        this.objSub.textContent = d < 4 ? 'HOLD NEAR BOMB TO DEFUSE' : `MOVE TO BOMB · ${Math.round(d)} M`;
      } else {
        this.objText.textContent = 'ELIMINATE THE HOSTILES';
        this.objProg.style.width = '100%';
        this.objSub.textContent = `WAVE ${Math.max(1, g.wave)} / 3 · ${g.waveEnemyCount} HOSTILES REMAINING`;
      }
    } else if (allWavesDown) {
      this.objText.textContent = 'BOMB DEFUSED';
      this.objProg.style.width = '100%';
      this.objSub.textContent = 'OPERATION COMPLETE';
    } else if (g.waveEnemyCount > 0 || g.waveActive) {
      // no bomb node left but hostiles are still alive: keep showing the wave goal
      this.objText.textContent = 'ELIMINATE THE HOSTILES';
      this.objProg.style.width = '100%';
      this.objSub.textContent = `WAVE ${Math.max(1, g.wave)} / 3 · ${g.waveEnemyCount} HOSTILES REMAINING`;
    } else {
      this.objText.textContent = 'ALL HOSTILES ELIMINATED';
      this.objProg.style.width = '100%';
      this.objSub.textContent = 'WAITING FOR NEXT WAVE';
    }
  }
  /** per-frame bits: crosshair bloom + compass */
  _hudDynamic(g) {
    const p = g.player, gun = g.guns;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const spread = 8 + gun.spreadBloom * 520 + (speed > 6 ? 6 : speed * 0.8) + (p.onGround ? 0 : 7);
    const ads = gun.adsWant > 0.5;
    // PERF: cache style strings — writing identical values every frame still costs
    // a style recalc on each of them (3 per frame, ~430/s).
    const spreadStr = (ads ? 2 : spread) + 'px';
    if (spreadStr !== this._chSpread) { this.crosshair.style.setProperty('--spread', spreadStr); this._chSpread = spreadStr; }
    const opStr = ads ? '0.45' : '1';
    if (opStr !== this._chOp) { this.crosshair.style.setProperty('--op', opStr); this._chOp = opStr; }
    if (this._chSpread === undefined) this.crosshair.style.display = ''; // one-time
    this.updateCompass(g);
    if (g.promptText) { this.prompt.classList.remove('hidden'); this.promptText.textContent = g.promptText; this.promptKbd.textContent = this.keyDisplay(g.settings.keybinds.interact || 'KeyB'); }
    else this.prompt.classList.add('hidden');
  }
  updateCompass(g) {
    const p = g.player;
    const band = $('#compass-band');
    const spacing = 60;
    const yawDeg = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
    const ringW = this.bandCount / 3 * spacing;
    const w = band.parentElement.clientWidth || 400;
    const x = -ringW - (yawDeg / 360) * ringW + w / 2 - spacing / 2;
    // PERF: transform writes every frame are unavoidable (it moves), but building
    // the template string per frame is not — round to 0.1px and cache the string.
    const tx = 'translate3d(' + (Math.round(x * 10) / 10) + 'px,0,0)';
    if (tx !== this._bandTx) { band.style.transform = tx; this._bandTx = tx; }
    // pings
    const pings = this.pings || (this.pings = $('#compass-pings'));
    if (!g.settings.pings) { if (this._pingCache) pings.innerHTML = ''; this._pingCache = ''; return; }
    const now = performance.now();
    if (now < (this._pingNext || 0)) return;
    this._pingNext = now + 66;
    const items = [];
    for (const e of g.enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z);
      // only show hostiles that are making noise or were spotted: shooting, sprinting toward player, within 25m
      const firing = (g.time - (e.lastShotTime || -9)) < 2.5;
      if (d < 26 || firing || e.seenNow) items.push({ x: e.pos.x, z: e.pos.z, cls: '', near: d < 12 });
    }
    for (const o of g.objectives) items.push({ x: o.pos.x, z: o.pos.z, cls: 'obj' });
    // DEFUSE PHASE: after the last wave, the bomb gets a strong off-screen pointer
    // (an arrow at the band edge) so you can always find it, even behind you.
    let bombEdge = null;
    if (g.waveDefuseUnlocked && g.objectives?.length) {
      let bomb = null, bestD = 1e9;
      for (const o of g.objectives) {
        const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
        if (d < bestD) { bestD = d; bomb = o; }
      }
      if (bomb) {
        const ang = Math.atan2(bomb.pos.x - p.pos.x, -(bomb.pos.z - p.pos.z));
        let deg = ((ang * 180 / Math.PI) % 360 + 360) % 360;
        let rel = deg - yawDeg; rel = ((rel + 540) % 360) - 180;
        if (Math.abs(rel) > 52) {
          // off-screen: clamp an arrow to the nearest band edge in that direction
          bombEdge = (rel < 0) ? -1 : 1;
        }
        // always render a big bomb ping, even when off-screen it stays clamped
        const clamped = Math.max(-52, Math.min(52, rel));
        const px = Math.round(w / 2 + clamped / 15 * spacing);
        items.unshift({ x: 0, z: 0, cls: 'bomb', edge: bombEdge, px, dist: Math.round(bestD) });
      }
    }
    let html = '';
    for (const it of items) {
      let px;
      if (it.cls === 'bomb') {
        px = it.px; // precomputed (clamped to band edge so it's always visible)
      } else {
        const ang = Math.atan2(it.x - p.pos.x, -(it.z - p.pos.z)); // world -> compass
        let deg = ((ang * 180 / Math.PI) % 360 + 360) % 360;
        let rel = deg - yawDeg; rel = ((rel + 540) % 360) - 180;
        if (Math.abs(rel) > 52) continue;
        px = Math.round(w / 2 + rel / 15 * spacing);
      }
      html += `<i class="${it.cls}${it.cls === 'bomb' && it.edge ? ' edge' + (it.edge > 0 ? ' right' : '') : ''}" style="left:${px}px;top:${it.cls === 'bomb' ? 8 : it.cls ? 20 : 22}px;opacity:1"></i>`;
    }
    if (html !== this._pingCache) { pings.innerHTML = html; this._pingCache = html; }
  }
  triggerHitMarker(head, kill) {
    this.crosshair.classList.remove('kill');
    this.crosshair.classList.add('hit');
    if (kill) this.crosshair.classList.add('kill');
    clearTimeout(this._hmT);
    this._hmT = setTimeout(() => this.crosshair.classList.remove('hit', 'kill'), 90);
  }
  damageFrom(pos, playerPos) {
    const dx = pos.x - playerPos.x, dz = pos.z - playerPos.z;
    const ang = Math.atan2(dx, -dz); // relative to world forward(-z)
    const rel = ang - playerPos.yaw;
    const deg = (-(rel) * 180 / Math.PI) % 360;
    const el = document.createElement('i');
    const wrap = $('#dmg-arrows');
    el.style.transform = `translate(-50%,-50%) rotate(${-deg}deg) translateY(-130px)`;
    wrap.appendChild(el);
    setTimeout(() => el.remove(), 1000);
    this.flash.style.opacity = '0.55';
    setTimeout(() => this.flash.style.opacity = '0', 90);
  }
  addKillfeed(text, head) {
    const el = document.createElement('div');
    el.className = 'kf';
    el.innerHTML = `<b>YOU</b>${head ? '<span class="hs">HEADSHOT</span>' : ''}<span>▸</span><b>${text}</b>`;
    this.killfeed.prepend(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; }, 3600);
    setTimeout(() => el.remove(), 4100);
    while (this.killfeed.children.length > 5) this.killfeed.lastChild.remove();
  }
  note(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'note ' + kind;
    el.textContent = text;
    this.notes.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(-6px)'; el.style.transition = '.4s'; }, 1800);
    setTimeout(() => el.remove(), 2300);
    while (this.notes.children.length > 3) this.notes.firstChild.remove();
  }
  setLoading(show, text, prog) {
    $('#loading').classList.toggle('hidden', !show);
    if (text) $('#ld-text').textContent = text;
    if (prog != null) $('#ld-fill').style.width = Math.round(prog * 100) + '%';
  }
  showDebrief(g, won) {
    $('#debrief-kicker').textContent = won ? 'OPERATION COMPLETE' : 'OPERATOR KIA';
    $('#debrief-title').textContent = won ? 'THEATRE SECURED' : 'MISSION FAILED';
    $('#debrief-title').style.color = won ? 'var(--amber)' : 'var(--red)';
    $('#debrief-sub').textContent = won ? 'All charges defused. Theatre secured. Extraction confirmed.' : 'You were neutralised before the theatre could be secured.';
    $('#debrief-stats').innerHTML = `
      <div><b>${g.stats.kills}</b><span>ELIMINATIONS</span></div>
      <div class="accent"><b>${g.stats.heads}</b><span>HEADSHOTS</span></div>
      <div><b>${Math.round(g.stats.acc * 100)}%</b><span>ACCURACY</span></div>
      <div><b>${String(Math.floor(g.missionTime / 60)).padStart(2, '0')}:${String(Math.floor(g.missionTime % 60)).padStart(2, '0')}</b><span>TIME</span></div>
      <div><b>${g.stats.shots}</b><span>ROUNDS FIRED</span></div>
      <div class="accent"><b>${g.stats.score}</b><span>SCORE</span></div>`;
    this.show('debrief');
  }
}

function cameraFit() { /* framing is computed at capture time */ }
