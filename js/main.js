// BREACHPOINT — main game controller
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/GLTFLoader.js';
import { Audio } from './audio.js';
import { Player, clamp, lerp } from './world.js';
import { Level, MAPS } from './level.js';
import { FX } from './effects.js';
import { WEAPONS, SHOP_ITEMS, Viewmodel, GunSystem } from './weapons.js';
import { Enemy, Squad, DIFFICULTY } from './ai.js';
import { buildSoldier } from './enemy_model.js';
import { Grenades } from './grenades.js';
import { ObjectiveNode } from './objective.js';
import { UI } from './ui.js';

function readSave(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

class Game {
  constructor() {
    const saved = readSave('bp_settings');
    // DEEP-MERGE keybinds: a shallow assign let OLD saves (which predate the
    // shop key and still carry interact:'KeyB') replace the defaults wholesale,
    // leaving settings.keybinds.shop undefined — so pressing B did nothing.
    const savedKeybinds = saved.keybinds || {};
    delete saved.keybinds;
    if (savedKeybinds.interact && !savedKeybinds.shop) savedKeybinds.shop = savedKeybinds.interact; // migrate old binds
    const DEFAULT_SETTINGS = {
      sens: 1.0, fov: 88, invertY: false, toggleAds: false, shake: true, q: 1,
      shadows: true, particles: true, motionBlur: false, gamma: 1.0, vol: 0.8, music: true,
      hitSound: true, damageTaken: 1, pings: true, vignette: true, blood: true,
      autoQuality: true, qualityLevel: 'medium', // low / medium / high
      keybinds: {
        leanLeft: 'KeyQ', leanRight: 'KeyE',
        reload: 'KeyR', melee: 'KeyV',
        weapon1: 'Digit1', weapon2: 'Digit2',
        throwable1: 'Digit3', throwable2: 'Digit4', throwable3: 'Digit5',
        shop: 'KeyB', defuse: 'KeyF',
      },
    };
    this.settings = Object.assign(DEFAULT_SETTINGS, saved, {
      keybinds: Object.assign(DEFAULT_SETTINGS.keybinds, savedKeybinds),
    });
    // guarantee shop keybind always has a value: an old save with shop:undefined
    // would wipe the default and pressing B would do nothing
    if (!this.settings.keybinds.shop) this.settings.keybinds.shop = 'KeyB';
    this.loadout = Object.assign({ primary: 'm4', secondary: 'p226' }, readSave('bp_loadout'));
    this.stats = Object.assign({ kills: 0, ops: 0, best: 0 }, readSave('bp_stats'));
    this.cash = Object.assign({ amount: 2500, owned: { m4: true, p226: true } }, readSave('bp_cash'));
    if (WEAPONS[this.loadout.primary]?.slot !== 0) this.loadout.primary = 'm4';
    if (WEAPONS[this.loadout.secondary]?.slot !== 1) this.loadout.secondary = 'p226';

    this.canvas = document.getElementById('game');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // capped: 4K panels murder GPU fill-rate
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;   // cheaper than PCFSoftShadowMap, less GPU pressure
    this.renderer.shadowMap.autoUpdate = true;   // live shadows: a stale shadow map paints the world grey
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x1a1d21, 1);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1d21);
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.05, 900);
    this.scene.add(this.camera);
    this.viewCamera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.01, 900);
    this.viewCamera.rotation.order = 'YXZ';
    // must live in the graph: the viewmodel and the firing ray both derive from
    // its world matrix (an orphan camera keeps an identity matrix)
    this.scene.add(this.viewCamera);

    this.activeCamera = this.viewCamera;
    this.audio = new Audio();
    this.audio.volume = this.settings.vol; this.audio.musicOn = this.settings.music;
    this.player = new Player(this.viewCamera);
    this.level = new Level(this.scene, this.renderer, this.camera);
    this.guns = new GunSystem(this.audio);
    this.viewmodel = new Viewmodel(this.viewCamera, this.audio);
    this.ui = new UI(this);

    this.mode = 'menu'; // menu | game | paused | debrief
    this.time = 0; this.missionTime = 0;
    this.clock = new THREE.Clock();
    this.enemies = []; this.squads = []; this.objectives = []; this.nodes = [];
    this.grenadeCount = 2; this.grenadeCd = 0;
    this.throwables = { smoke_bomb: 0, flashbang: 0, grenade: 0 };
    this.throwableSlots = [];       // ordered list of throwable type strings in inventory
    this.selectedThrowable = -1;    // index into throwableSlots; -1 = weapon selected
    this.currentThrowable = 'grenade';
    this.playerArmor = { kevlar: 0, helmet: 0 };
    // ---- wave system (3 waves before defuse unlocks, +2 enemies each wave)
    this.wave = 0; this.waveActive = false; this.waveDefuseUnlocked = false;
    this.waveEnemyCount = 0; this.waveStartT = 0;
    this.waveEnemies = [];
    this.waveCountdownT = 0; // seconds remaining before next wave auto-starts
    this.stats_run = { kills: 0, heads: 0, shots: 0, hits: 0, acc: 0, score: 0 };
    this.playerNoise = 0;
    this.input = { f: 0, b: 0, l: 0, r: 0, jump: false, sprint: false, crouch: false };
    this.keys = {};
    this.mouse = { dx: 0, dy: 0, down: false, ads: false };
    this.soldierGLTF = null;
    this.menuMixer = null;
    this.c4GLTF = null; this.throwModels = {};
    this.fpsAcc = 0; this.fpsFrames = 0;
    this.lastDeathT = -99;
    this.promptText = null;
    this._tmpV = new THREE.Vector3(); this._tmpV2 = new THREE.Vector3(); this._tmpV3 = new THREE.Vector3();
    this.scoreMulti = 1;
    this._shopOpen = false;

    this.bindInput();
    this.bindResize();
    this.applySettings();
    this.preload();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  /* ===================== boot & preload ===================== */
  async preload() {
    const btn = document.getElementById('boot-enter');
    const fill = document.querySelector('.boot-bar i');
    const status = document.querySelector('.boot-status');
    const steps = [
      ['SYNCING OPERATOR PROFILE…', 0.15],
      ['LOADING BALLISTIC MODELS…', 0.35],
      ['CALIBRATING TERRAIN…', 0.6],
    ];
    let i = 0;
    const tick = setInterval(() => {
      if (i < steps.length) { status.textContent = steps[i][0]; fill.style.width = steps[i][1] * 100 + '%'; i++; }
    }, 140);
    try {
      // load soldier model once (enemies need it); show menu immediately, backdrop loads in background
      const loader = new GLTFLoader();
      this.soldierGLTF = await loader.loadAsync('./assets/characters/soldier_enemy.glb');
      // load deployable/C4 and throwable models for objectives & shop utility
      this.c4GLTF = await loader.loadAsync('./assets/c4.glb');
      this.throwModels.c4 = this.c4GLTF;
      for (const id of ['flashbang','grenade','smoke_bomb']) {
        try { this.throwModels[id] = await loader.loadAsync('./assets/' + id + '.glb'); } catch (e) { console.warn('throwable load failed', id, e); }
      }
      fill.style.width = '100%'; status.textContent = 'READY';
      // backdrop loaded async so it never blocks boot
      this.buildMenuBackdrop(this.ui.selectedMap).catch(() => {});
    } catch (e) { console.error('preload failed', e); }
    clearInterval(tick);
    setTimeout(() => btn.classList.add('show'), 200);
    window.__BP_READY = true;
  }

  async buildMenuBackdrop(mapId) {
    this.ui.setMenuMap?.name; // no-op guard
    this.menuMap = mapId;
    if (this.menuLevel) { this.menuLevel.unload(); this.menuLevel = null; }
    const lvl = new Level(this.scene, this.renderer, this.camera);
    await lvl.load(mapId, { shadows: true, particles: true });
    this.menuLevel = lvl;
    // cinematic camera rail around the map
    const b = lvl.bounds;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const r = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.62;
    this.menuOrbit = { cx, cz, r, y: 16 + r * 0.14, a: Math.PI * 0.25 };
    const sp = lvl.spawns?.[0];
    this.camera.position.set(cx, this.menuOrbit.y, cz + r);
    this.camera.lookAt(cx, 2, cz);
    this.menuTarget = new THREE.Vector3(cx, 2, cz);
  }

  setMenuBackdrop(mapId) {
    if (this.mode !== 'menu') return;
    if (this._menuSwitching) return;
    this._menuSwitching = true;
    this.buildMenuBackdrop(mapId).finally(() => { this._menuSwitching = false; });
  }

  enterFromBoot() {
    this.audio.init();
    this.audio.startMusic();
    this.audio.ui('click');
    document.getElementById('screen-boot').classList.remove('active');
    this.ui.show('menu');
    this.updateMenuStats();
  }
  updateMenuStats() {
    document.getElementById('stat-kills').textContent = this.stats.kills;
    document.getElementById('stat-ops').textContent = this.stats.ops;
    document.getElementById('stat-best').textContent = this.stats.best || '—';
  }
  save() {
    localStorage.setItem('bp_settings', JSON.stringify(this.settings));
    localStorage.setItem('bp_loadout', JSON.stringify(this.loadout));
    localStorage.setItem('bp_stats', JSON.stringify(this.stats));
  }
  setLoadout(slot, id) {
    this.loadout[slot === 0 ? 'primary' : 'secondary'] = id;
    this.save();
  }
  applySettings() {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5) * (0.55 + 0.45 * this.settings.q) * (this._dynScale || 1));
    const pres = this.level?.presentation;
    // the theatre's authored exposure is the base; the brightness slider scales it. clamp gamma so exposure can never hit zero (black screen)
    const gamma = Math.max(this.settings.gamma || 1.0, 0.5);
    this.renderer.toneMappingExposure = (pres ? pres.exposure : 1.05) * gamma;
    if (pres?.fog && this.level?.map) {
      const sc = this.level.map.scene || this.scene;
      sc.fog = new THREE.FogExp2(pres.fog[0], pres.fog[1]);
    }
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    this.viewCamera.fov = this.settings.fov;
    this.viewCamera.updateProjectionMatrix();
    this.audio.setVolume(this.settings.vol);
  }

  /* ===================== input ===================== */
  bindInput() {
    addEventListener('keydown', (e) => {
      const kb = this.settings.keybinds;
      const moveKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'Tab'];
      if (this.mode === 'game' && [...moveKeys, kb.leanLeft, kb.leanRight, kb.reload, kb.melee, kb.weapon1, kb.weapon2, kb.throwable1, kb.throwable2, kb.throwable3].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true;
      // Shop FIRST: old saves could leave kb.shop undefined, and the early return
      // below bailed out before the shop binding was ever consulted.
      const shopKey = kb.shop || 'KeyB';
      if (this.mode !== 'game' && !(this.mode === 'paused' && e.code === shopKey)) return;
      if (e.code === shopKey && (this.mode === 'game' || this.mode === 'paused')) {
        e.preventDefault();
        if (!e.repeat) this.toggleShop();
        return;
      }
      if (e.code === 'Escape') { this.pause(); return; }
      if (e.repeat) return;
      switch (e.code) {
        case kb.reload: this.guns.startReload(); break;
        case kb.weapon1: this.guns.equipSlot(0); this.selectedThrowable = -1; this.audio.ui('click'); break;
        case kb.weapon2: this.guns.equipSlot(1); this.selectedThrowable = -1; this.audio.ui('click'); break;
        case kb.throwable1: this.selectThrowableSlot(0); break;
        case kb.throwable2: this.selectThrowableSlot(1); break;
        case kb.throwable3: this.selectThrowableSlot(2); break;
        case kb.leanLeft: this.player.wantLean = -1; break;
        case kb.leanRight: this.player.wantLean = 1; break;
        case kb.melee: this.melee(); break;
        case kb.defuse: this.toggleDefuse(); break;
        case 'Tab': case 'KeyC': this.audio.ui('click'); break;
      }
    });
    addEventListener('keyup', (e) => {
      const kb = this.settings.keybinds;
      this.keys[e.code] = false;
      if (e.code === kb.leanLeft && this.player.wantLean === -1) this.player.wantLean = 0;
      if (e.code === kb.leanRight && this.player.wantLean === 1) this.player.wantLean = 0;
    });
    addEventListener('blur', () => { this.keys = {}; this.mouse.down = false; if (this.mode === 'game') this.pause(); });
    // clicking the canvas re-acquires the mouse if the lock was lost without a pause
    addEventListener('click', (e) => {
      if (this.mode === 'game' && document.pointerLockElement !== this.canvas && e.target === this.canvas) this._lockPointer();
    });

    const lockTarget = this.canvas;
    document.addEventListener('pointerlockchange', () => {
      if (this._shopOpen) return;
      if (document.pointerLockElement !== lockTarget && this.mode === 'game') this.pause(true);
    });
    document.addEventListener('mousemove', (e) => {
      if (this.mode !== 'game' || document.pointerLockElement !== lockTarget) return;
      this.look(e.movementX, e.movementY);
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (this.mode !== 'game') return;
      if (document.pointerLockElement !== lockTarget) { this._lockPointer(); return; }
      if (e.button === 0) { this.mouse.down = true; this.mouse.pressed = true; }
      if (e.button === 2) { this.setAds(this.settings.toggleAds ? !this.mouse.ads : true); }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
      if (e.button === 2 && !this.settings.toggleAds) this.setAds(false);
    });
    addEventListener('contextmenu', (e) => e.preventDefault());
  }
  look(dx, dy) {
    const s = 0.0021 * this.settings.sens * (this.mouse.ads ? 0.62 : 1);
    this.player.yaw -= dx * s;
    this.player.pitch -= dy * s * (this.settings.invertY ? -1 : 1);
    this.player.pitch = clamp(this.player.pitch, -1.5, 1.5);
    this.player.yaw = ((this.player.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.mouse.dx = dx; this.mouse.dy = dy;
  }
  setAds(v) { this.mouse.ads = v; }
  keyName(code) {
    const map = { Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL', Escape: 'ESC' };
    if (map[code]) return map[code];
    if (code.startsWith('Digit')) return code[5];
    if (code.startsWith('Key')) return code[3];
    return code;
  }
  bindResize() {
    const onResize = () => {
      this.renderer.setSize(innerWidth, innerHeight, false);
      this.camera.aspect = innerWidth / innerHeight;
      this.viewCamera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix(); this.viewCamera.updateProjectionMatrix();
      this.applySettings();
    };
    addEventListener('resize', onResize); onResize();
    // WebGL context loss (grey screen on fullscreen toggle) — recover gracefully
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._ctxLost = true;
      this.ui.note('GRAPHICS LOST — RECOVERING…', 'bad');
    }, false);
    this.canvas.addEventListener('webglcontextrestored', () => {
      this._ctxLost = false;
      this._ctxLostT = 0;
      this.renderer.shadowMap.needsUpdate = true;
      this.renderer.setSize(innerWidth, innerHeight, false);
      this.camera.aspect = innerWidth / innerHeight;
      this.viewCamera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix(); this.viewCamera.updateProjectionMatrix();
      this.applySettings();
      this.ui.note('GRAPHICS RECOVERED', '');
    }, false);
  }

  /* ===================== loading a mission ===================== */
  /** pointer lock is a user-gesture API: surface a click-to-capture overlay instead of an unhandled rejection */
  _lockPointer() {
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => this.ui?.note?.('CLICK TO CAPTURE MOUSE', ''));
    } catch (e) { /* non-fatal */ }
  }
  async startGame(mapId, mode = 'breach', diff = 'operator') {
    this.ui.setLoading(true, 'LOADING THEATRE…', 0.08);
    this.mode = 'loading';
    this.audio.ui('click');
    this.selectedMap = mapId; this.gameMode = mode; this.diff = DIFFICULTY[diff] || DIFFICULTY.operator;
    this.endlessMode = mode === 'endless';
    this.ui.hideAll();
    try {
      // hand the menu backdrop over to the mission (same loader pipeline)
      if (this.menuLevel) { this.menuLevel.unload(); this.menuLevel = null; }
      this.scene.fog = null;
      this.clearWorld();
      // cinematic pass on the loading screen: hide the fully lit HUD and fades through black
      document.getElementById('hud').style.opacity = '0';
      this.ui.setLoading(true, 'BUILDING COLLISION & NAVIGATION…', 0.35);
      await new Promise(r => setTimeout(r, 30));
      this.clock.running = false;
      const t0 = performance.now();
      await this.level.load(mapId, { shadows: this.settings.shadows, particles: this.settings.particles, mergeStatic: false, onProgress: (t) => this.ui.setLoading(true, t, 0.6) });
      console.info('[bp] load', mapId, Math.round(performance.now() - t0) + 'ms');
      this.ui.setLoading(true, 'DEPLOYING HOSTILES…', 0.8);
      await new Promise(r => setTimeout(r, 20));
      await this.setupMission(mapId);
      this.ui.setLoading(true, 'READY', 1);
    } catch (e) {
      console.error('setupMission caught', e);
      this.ui.setLoading(true, 'DEPLOYING BARE MISSION', 1);
      // guarantee minimal valid state so the game loop never dies and the screen
      // never goes black, no matter where setupMission threw:
      if (!this.fx) this.fx = new FX(this.scene, this.level.colliders, this.viewCamera);
      if (!this.grenades) this.grenades = new Grenades(this.scene, this.level.colliders, this.fx, this.audio);
      if (!this.squads) this.squads = [];
      if (!this.enemies) this.enemies = [];
      if (!this.objectives) this.objectives = [];
      if (!this.nodes) this.nodes = [];
      if (!this.viewmodel.envMap) {
        const pmrem = new THREE.PMREMGenerator(this.renderer);
        const envScene = new THREE.Scene();
        envScene.background = new THREE.Color(0x2a3038);
        const g = new THREE.SphereGeometry(1, 8, 8);
        const add = (color, pos, scale) => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color })); m.position.set(...pos); m.scale.setScalar(scale); envScene.add(m); };
        add(0xffffff, [3, 4, 3], 2.2); add(0x8fa8ff, [-3, 1, -2], 2.0); add(0xffc890, [-2, -2, 3], 1.4);
        this.viewmodel.envMap = pmrem.fromScene(envScene, 0.04).texture;
        pmrem.dispose();
      }
      // camera + map + light + exposure: without these the screen is black
      this.viewCamera.position.copy(this.player.pos).add(new THREE.Vector3(0, this.player.eyeHeight, 0));
      this.viewCamera.rotation.set(0, this.player.yaw, 0, 'YXZ');
      this.viewCamera.updateMatrixWorld();
      const root = this.level.map && this.level.map.root;
      if (root && !root.parent) this.scene.add(root);
      if (root) { root.visible = true; root.frustumCulled = false; }
      if (!this._deployLight) {
        this._deployLight = new THREE.HemisphereLight(0xffffff, 0x888888, 2.0);
        this.scene.add(this._deployLight);
      }
      if (this.level?.presentation) {
        this.renderer.toneMappingExposure = Math.max(this.level.presentation.exposure, 1.4) * Math.max(this.settings.gamma || 1.0, 0.5);
      } else {
        this.renderer.toneMappingExposure = 1.2;
      }
      this.scene.fog = new THREE.FogExp2(0x1a1d21, 0.02);
      // guarantee the gun is equipped so the player can always shoot
      this.guns.reset();
      this.guns.loadout = { primary: this.loadout.primary, secondary: this.loadout.secondary };
      this.guns.equipSlot(0, true);
      this.viewmodel.equip(this.guns.def.id);
    }
    await new Promise(r => setTimeout(r, 180));
    this.ui.setLoading(false);
    this.mode = 'game';
    // reset cash and loadout on every deploy so each operation starts fresh
    this.cash = { amount: 2500, owned: { m4: true, p226: true } };
    this.loadout = { primary: 'm4', secondary: 'p226' };
    this.playerArmor = { kevlar: 0, helmet: 0 };
    this.throwables = { smoke_bomb: 0, flashbang: 0, grenade: 0 };
    this.throwableSlots = [];
    this.selectedThrowable = -1;
    localStorage.setItem('bp_cash', JSON.stringify(this.cash));
    localStorage.setItem('bp_loadout', JSON.stringify(this.loadout));
    document.getElementById('hud').style.opacity = '1';
    this.ui.setHud(true);
    this.ui.hideAll();
    this.clock.start();
    this.clock.getDelta();
    this._lockPointer();
    this.audio.stopMusic();
    this.audio.setCombatMusic(true);
    // keep the exposure the map loader authored (it is tuned per theatre for ACES) —
    // overwriting it with a flat constant is what turned every level pitch black
    if (this.level?.def) this.renderer.toneMappingExposure = Math.max((this.level.presentation?.exposure ?? 1.05), 1.2) * Math.max(this.settings.gamma || 1.0, 0.5);
    
    // ensure scene environment is set for PBR materials (prevents black void in gameplay)
    // the menu camera may have environment, but gameplay camera needs it too
    if (!this.scene.environment) {
      // try to restore environment from the loaded map preset
      const mapName = this.level?.def?.id || 'factory';
      const presets = { factory: 1.05, snow: 1.0, desert: 1.1 };
      const exposure = presets[mapName] || 1.05;
      this.renderer.toneMappingExposure = Math.max(exposure, 0.5) * Math.max(this.settings.gamma || 1.0, 0.5);
    }
    
    this.ui.note(`${MAPS[mapId].name} · ${this.gameMode.toUpperCase()}`, '');
    setTimeout(() => this.ui.note('ARM THE RELAY CHARGES', ''), 1600);
  }

  async setupMission(mapId) {
    // fx first: AI fire, explosions and the spawn effects all reach for game.fx
    if (this.fx) this.fx.dispose();
    this.fx = new FX(this.scene, this.level.colliders, this.viewCamera);
    this.grenades = new Grenades(this.scene, this.level.colliders, this.fx, this.audio);
    this.enemies = []; this.squads = [];
    this.missionTime = 0; this.time = 0;
    this.stats_run = { kills: 0, heads: 0, shots: 0, hits: 0, acc: 0, score: 0 };
    this.grenadeCount = 3; this.grenadeCd = 0;
    this.scoreMulti = 1;
    this.player.reset(this.level.playerSpawn);
    // snap feet to solid floor so the player never phases through the ground on deploy
    const g = this.level.colliders.groundHeight(this.player.pos.x, this.player.pos.z, this.player.pos.y + 1, 1.5);
    if (isFinite(g)) this.player.pos.y = g + 0.05;
    this.player.onGround = true;
    this.player.kevlar = this.playerArmor.kevlar;
    this.player.helmet = this.playerArmor.helmet;
    // seed the operator camera at the deploy point so the first frame never
    // renders from the origin (black void on the frame before updateGame runs)
    this.viewCamera.position.copy(this.player.pos).add(new THREE.Vector3(0, this.player.eyeHeight, 0));
    this.viewCamera.rotation.set(0, this.player.yaw, 0, 'YXZ');
    this.viewCamera.updateMatrixWorld();
    this.viewCamera.matrixAutoUpdate = true;
    // point the camera at the nearest objective so it never looks into empty space
    const firstObj = this.level.objectives[0];
    if (firstObj) {
      const target = new THREE.Vector3(firstObj.pos.x, firstObj.pos.y + 1, firstObj.pos.z);
      this.viewCamera.lookAt(target);
      this.viewCamera.rotation.x = Math.max(-1.2, Math.min(0.6, this.viewCamera.rotation.x));
    }
    this.viewCamera.updateMatrixWorld();
    // guarantee the map root is in the scene and visible (loader detaches/re-adds during batching)
    const root = this.level.map && this.level.map.root;
    if (root && !root.parent) this.scene.add(root);
    if (root) {
      root.visible = true; root.frustumCulled = false;
      root.traverse(o => {
        if (o.isMesh) { o.visible = true; o.frustumCulled = false; }
        if (o.isMesh && o.geometry && !(o.geometry.boundingSphere && isFinite(o.geometry.boundingSphere.radius))) {
          try { o.geometry.computeBoundingSphere(); } catch (e) { o.frustumCulled = false; }
        }
      });
    }
    // force bright exposure so the world is never dark
    if (this.level?.presentation) this.renderer.toneMappingExposure = Math.max(this.level.presentation.exposure, 1.4) * Math.max(this.settings.gamma || 1.0, 0.5);
    // guarantee at least one visible light so the world is never fully black
    if (!this._deployLight) {
      this._deployLight = new THREE.HemisphereLight(0xffffff, 0x888888, 2.0);
      this.scene.add(this._deployLight);
    }
    const pl = new THREE.PointLight(0xffffff, 4, 50);
    pl.position.copy(this.player.pos);
    this._deployPl = pl;
    this.scene.add(pl);
    this.guns.reset();
    this.guns.loadout = { primary: this.loadout.primary, secondary: this.loadout.secondary };

    // ---- objective nodes
    this.objectives = this.level.objectives.map(o => ({ ...o }));
    this.nodes = this.objectives.map(o => new ObjectiveNode(this.scene, o, parseInt(MAPS[mapId].accent.slice(1), 16), this.c4GLTF));
    if (this.gameMode === 'survival') this.objectives.forEach(o => o.defensive = true);

    // ---- hostiles in squads (wave system: 3 waves before defuse unlocks, +2 each wave)
    const squads = [new Squad(this, 0), new Squad(this, 1), new Squad(this, 2)];
    const spawnCells = this.level.enemySpawns;
    this.wave = 0; this.waveActive = false; this.waveDefuseUnlocked = false;
    this.waveEnemyCount = 0; this.waveEnemyCount = 0;
    this.waveEnemies = [];
    this.squads = squads;
    // start wave 1
    try { this.startWave(1); } catch (e) { console.error('startWave failed', e); }
    // give every squad points around objective nodes so they guard the relays
    for (const sq of squads) {
      for (const o of this.objectives) {
        const i = this.level.nav.nearestWalkable(o.pos.x + (Math.random() - 0.5) * 12, o.pos.z + (Math.random() - 0.5) * 12);
        if (i >= 0) sq.patrolPoints.push(i);
      }
    }

    // ---- hook weapon fire
    this.guns.onFire = (def, spread, ads) => this.shoot(def, spread, ads);
    this.guns.onStateChange = () => { };
    // viewed gun sits on the camera; its lights/shadow casters would double-render through walls
    if (this.viewmodel.root.parent !== this.viewCamera) this.viewCamera.add(this.viewmodel.root);
    this.viewmodel.equip(this.loadout.primary);
    this.guns.def = null;
    this.guns.equipSlot(0, true);
    await this.ensureViewmodels();
    this.viewmodel.ads = 0; this.viewmodel.lower = 0.4;
    this.viewmodel.equip(this.guns.def.id);
    this.viewmodel.loaded = true;
    // metallic PBR materials read as black without an environment: generate one
    if (!this.viewmodel.envMap) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      envScene.background = new THREE.Color(0x2a3038);
      const g = new THREE.SphereGeometry(1, 8, 8);
      const add = (color, pos, scale) => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color })); m.position.set(...pos); m.scale.setScalar(scale); envScene.add(m); };
      add(0xffffff, [3, 4, 3], 2.2); add(0x8fa8ff, [-3, 1, -2], 2.0); add(0xffc890, [-2, -2, 3], 1.4);
      this.viewmodel.envMap = pmrem.fromScene(envScene, 0.04).texture;
      pmrem.dispose();
      this.viewmodel.root.traverse(o => { if (o.isMesh && o.material) { o.material.envMap = this.viewmodel.envMap; o.material.envMapIntensity = 1.2; o.material.needsUpdate = true; } });
    }

    // apply the environment map to every hostile's PBR materials so they render
    // instead of reading solid black / invisible under the theatre lighting
    const eEnv = this.viewmodel.envMap || this.scene.environment;
    if (eEnv) {
      for (const e of this.enemies) {
        e.root.traverse(o => {
          if (o.isMesh && o.material && o.material.envMap !== undefined && !o.material.envMap) {
            o.material.envMap = eEnv;
            o.material.envMapIntensity = 1.0;
            o.material.needsUpdate = true;
          }
          o.visible = true;
          o.frustumCulled = false;
        });
      }
    }

    this.grenades.onExplode = (pos, dmg, radius, enemy) => this.explode(pos, dmg, radius, enemy);
    // warn hostiles about the first shot they hear
    this.combatMusicT = 0;
  }

  async ensureViewmodels() {
    this._vmLoading = this._vmLoading || {};
    if (this.viewmodel.root.parent !== this.viewCamera) this.viewCamera.add(this.viewmodel.root);
    if (!this.viewmodel.models[this.loadout.primary]) {
      try {
        const gltf = await new GLTFLoader().loadAsync('./assets/weapons/' + WEAPONS[this.loadout.primary].file);
        this.viewmodel.addModel(this.loadout.primary, gltf.scene);
        this.viewmodel.equip(this.loadout.primary);
      } catch (e) { console.error('viewmodel load failed', e); }
    }
    for (const id of [this.loadout.primary, this.loadout.secondary]) {
      if (this.viewmodel.models[id] || this._vmLoading[id]) continue;
      this._vmLoading[id] = true;
      try {
        const gltf = await new GLTFLoader().loadAsync('./assets/weapons/' + WEAPONS[id].file);
        this.viewmodel.addModel(id, gltf.scene);
        if (id === this.guns.def.id) this.viewmodel.equip(id);
      } catch (e) { console.error('viewmodel load failed', id, e); }
    }
  }

  clearWorld() {
    for (const e of this.enemies) { if (e.dispose) e.dispose(); else this.scene.remove(e.root); }
    this.enemies = [];
    for (const n of this.nodes) n.dispose(this.scene);
    this.nodes = []; this.objectives = [];
    if (this.fx) this.fx.dispose();
    this.fx = null;
    this.grenades?.clear();
    this.grenades = null;
    this.level.unload();
  }

  /* ===================== combat ===================== */
  shoot(def, spread, ads) {
    const cam = this.viewCamera;
    // PERF: this ran per shot (and hitmarker-path clones below); use scratch vectors.
    const origin = (this._shootO ||= new THREE.Vector3());
    const baseDir = (this._shootD ||= new THREE.Vector3());
    cam.getWorldPosition(origin);
    cam.getWorldDirection(baseDir);
    const right = (this._shootR ||= new THREE.Vector3()).crossVectors(baseDir, cam.up).normalize();
    const up = (this._shootU ||= new THREE.Vector3()).crossVectors(right, baseDir).normalize();
    const pellets = def.pellets || 1;
    this.stats_run.shots += pellets;
    let hitAnything = false, headKill = false, killed = false;
    const muzzleWorld = this.viewmodel.muzzleWorld((this._shootM ||= new THREE.Vector3()));
    const tracerStart = muzzleWorld;
    const d = (this._shootDir ||= new THREE.Vector3());
    for (let p = 0; p < pellets; p++) {
      d.copy(baseDir);
      const sp = spread * (pellets > 1 ? 1.6 : 1);
      d.addScaledVector(right, (Math.random() - 0.5) * 2 * sp).addScaledVector(up, (Math.random() - 0.5) * 2 * sp).normalize();
      const res = this.castShot(origin, d, def);
      if (res.hitEnemy) { hitAnything = true; if (res.head) headKill = true; if (res.killed) killed = true; }
      if (p < 4 || pellets === 1) this.fx.tracer(tracerStart, res.point);
    }
    // fx / audio
    this.audio.shot(def.sound, null);
    this.fx.muzzle.fire(muzzleWorld, baseDir, def.scope ? 1.2 : 1);
    // muzzle spark cone for cooler 3D gun flash
    // scratch vector shared by all pellet/spark offsets (was an undeclared `_fv`,
    // which threw ReferenceError on EVERY shot and killed recoil entirely)
    const sparkDir = (this._fv ||= new THREE.Vector3());
    for (let i = 0; i < 6; i++) {
      const sd = baseDir.clone().add(sparkDir.set((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4).normalize());
      this.fx.sparks.spawn(muzzleWorld.x, muzzleWorld.y, muzzleWorld.z, sd.x * 3, sd.y * 3, sd.z * 3,
        { life: 0.12 + Math.random() * 0.08, size: 0.07, color: 0xfff2c0, grav: 0.8, stretch: 1.5 });
    }
    const eject = cam.localToWorld((this._shootE ||= new THREE.Vector3()).set(0.12, -0.12, -0.25));
    this.fx.casings.spawn(eject, (this._shootEV ||= new THREE.Vector3()).set(2 + Math.random(), 2 + Math.random(), (Math.random() - 0.5)));
    // recoil
    const k = this.player.crouch > 0.5 ? 0.7 : this.player.onGround ? 1 : 1.6;
    const adsK = ads ? 0.62 : 1;
    // The raw def.recoil values are ~0.008 rad: far too small to see. Scale them
    // into a readable kick and hold briefly so sustained fire climbs.
    const rec = 3.2;
    this.player.addRecoil(
      def.recoil[0] * rec * k * adsK * (0.8 + Math.random() * 0.4),
      def.recoil[1] * rec * k * adsK * (Math.random() - 0.5) * 2,
      0.09,
    );
    this.player.shake = Math.min(1, this.player.shake + (this.settings.shake ? def.kick * 0.05 : 0));
    this.viewmodel.fireKick(def.kick);
    if (this.settings.shake) this.recoilCam = (this.recoilCam || 0) + def.kick * 0.01;
    // gunfire is loud: nearby hostiles investigate
    this.playerNoise = 1.0;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = e.pos.distanceTo(this.player.pos);
      if (d < (def.scope ? 95 : 65)) {
        e.alertness = Math.max(e.alertness, 0.8);
        if (e.state === 'patrol') { e.lastSeen.copy(this.player.pos); e.lastSeenT = this.time + 2; e.setPathTo(this.player.pos, 'investigate'); }
        if (d < 50) e.squad?.reportSighting(e, this.player.pos);
      }
    }
    if (hitAnything && this.settings.hitSound) { this.audio.hitmarker(headKill); this.ui.triggerHitMarker(headKill, killed); }
  }

  /** debug hook for QA only — not used by gameplay */
  castRayForTest(origin, dir) {
    const r = this.level.raycast(origin, dir, 60);
    return r ? { t: +r.t.toFixed(2), point: r.point.toArray().map(v => +v.toFixed(2)) } : { t: null };
  }

  castShot(origin, dir, def) {
    const maxDist = 140;
    // PERF: reuse scratch result objects — castShot ran per pellet per shot and
    // allocated two vectors + a result object each call (shotgun = 27 allocs/shot).
    const best = this._shotBest || (this._shotBest = {});
    best.point = best.point || new THREE.Vector3();
    best.point.copy(origin).addScaledVector(dir, maxDist);
    best.hitEnemy = null; best.head = false; best.killed = false; best.dist = maxDist; best.isWorld = false; best.normal = null;
    const worldHit = this.level.raycast(origin, dir, maxDist);
    if (worldHit) { best.point = worldHit.point; best.dist = worldHit.t; best.normal = worldHit.normal; best.isWorld = true; }
    // sphere volumes calibrated to the 1.22x soldier scale in enemy_model.js
    const SC = 1.22;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const feet = e.pos;
      const crouchDrop = e.crouch * 0.55 * SC;
      const top = feet.y + 1.62 * SC - crouchDrop;         // crown of the head
      const h = 1.78 * SC - crouchDrop;                    // total standing height
      // cheap reject: the ray must pass near this soldier at all
      const rdx = feet.x - origin.x, rdz = feet.z - origin.z;
      const perp = Math.abs(rdx * -dir.z + rdz * dir.x);
      const along = rdx * dir.x + rdz * dir.z;
      if (along < -1 || along > best.dist + 1 || perp > 1.3) continue;
      const c = _shotC;
      // head: a little larger than the helmet so headshots reward aim, not pixel hunting
      const hitHead = raySphere(origin, dir, c.set(feet.x, top - 0.14 * SC, feet.z), 0.27, best.dist);
      // torso as a stack of three spheres from hips to shoulders
      let hitBody = null;
      for (let k = 0; k < 3; k++) {
        const t = raySphere(origin, dir, c.set(feet.x, feet.y + h * (0.30 + k * 0.22), feet.z), k === 0 ? 0.44 : 0.47, best.dist);
        if (t !== null && (hitBody === null || t < hitBody)) hitBody = t;
      }
      const t = hitHead !== null ? hitHead : hitBody;
      if (t === null) continue;
      if (t > best.dist) continue;
      // never register a hit through a wall even if the sphere pokes out of geometry
      if (worldHit && t > worldHit.t + 0.05) continue;
      best.dist = t;
      best.hitEnemy = e; best.head = hitHead !== null; best.isWorld = false;
      best.point.copy(origin).addScaledVector(dir, t);
      best.normal = best.normal || new THREE.Vector3(); best.normal.copy(dir).negate();
    }
    if (best.hitEnemy) {
      const e = best.hitEnemy;
      let dmg = def.dmg;
      const head = best.head;
      if (head) dmg *= def.head;
      // range falloff
      const [near, far] = def.falloff;
      if (best.dist > near) dmg *= lerp(1, 0.55, clamp((best.dist - near) / (far - near), 0, 1));
      if (best.head) this.stats_run.heads += 0;
      this.lastShotDebug = { dist: +best.dist.toFixed(2), head: best.head, dmg: +dmg.toFixed(1), hpBefore: +e.hp.toFixed(1) };
      const killed = e.hit(dmg, best.point, dir, best.head);
      this.stats_run.hits++; this.stats_run.acc = this.stats_run.hits / Math.max(1, this.stats_run.shots);
      if (this.settings.blood) this.fx.bloodBurst(best.point, dir, best.head ? 14 : 7);
      e.setHitFlash();
      if (killed) {
        this.onEnemyKilled(e, best.head);
        best.killed = true;
        if (best.head) this.stats_run.heads++;
      }
    } else {
      // world impact
      this.lastShotDebug = { miss: true, t: +best.dist.toFixed(2), dir: dir.toArray().map(v => +v.toFixed(2)) };
      if (best.normal) this.fx.impact(best.point, best.normal, 'concrete');
      this.audio.impact(best.point);
      // bullet holes + sparks tell the range
    }
    return best;
  }

  onEnemyKilled(e, head) {
    this.stats_run.kills++;
    this.stats.kills++;
    this.ui.addKillfeed(head ? 'HOSTILE · HEADSHOT' : 'HOSTILE', head);
    this.audio.kill();
    this.stats_run.score += head ? 150 : 100;
    this.cash.amount += head ? 200 : 120;
    localStorage.setItem('bp_cash', JSON.stringify(this.cash));
    this.ui.note(`+$${head ? 200 : 120} KILL${head ? ' · HEADSHOT' : ''}`, 'warn');
    this.fx.bloodBurst(e.pos.clone().add(new THREE.Vector3(0, 1.3, 0)), new THREE.Vector3(0, 1, 0), 16);
    // drop ammo every 3rd kill
    if (this.stats_run.kills % 3 === 0) { this.guns.addAmmo(0.4); this.ui.note('AMMO RESUPPLIED', ''); this.audio.pickup(); }
    e.squad?.callout(e, 'killed', 3);
    this.onEnemyDie(e);
    if (this.enemies.every(x => x.dead)) {
      // all clear: give a breather + more ammo
      this.guns.addAmmo(0.6); this.ui.note('THEATRE CLEAR — RESUPPLY INBOUND', 'warn');
    }
    this.save();
  }
  damagePlayer(amount, fromPos) {
    if (!this.player.alive) return;
    const a = amount * this.settings.damageTaken;
    const dealt = this.player.damage(a);
    this.audio.hurt();
    this.ui.damageFrom(fromPos, this.player);
    if (!this.player.alive) this.onPlayerDeath();
  }
  onPlayerDeath() {
    if (this.mode !== 'game') return;
    this.lastDeathT = this.time;
    this.audio.setCombatMusic(false);
    this.player.wantLean = 0;
    this.deaths = (this.deaths || 0) + 1;
    this.ui.note('OPERATOR DOWN · REDEPLOY IN 4', 'bad');
    // redeploy at a safe spot, keep the mission going (arcade-smooth, no hard stop)
    clearTimeout(this._respawnT);
    this._respawnT = setTimeout(() => {
      if (this.mode !== 'game' || this.player.alive) return;
      const near = this.enemies.reduce((acc, e) => (!e.dead && (!acc || e.pos.distanceTo(this.player.pos) < acc.pos.distanceTo(this.player.pos)) ? e : acc), null);
      const sp = this.level.chooseSpawn(this.level.nav, this.player.pos, near ? near.pos : null) || this.level.playerSpawn;
      this.player.reset(sp);
      this.player.pos.y = sp.position.y + 0.05;
      this.viewCamera.rotation.z = 0;
      this.guns.addAmmo(0.5);
      this.grenadeCount = Math.max(this.grenadeCount, 2);
      this.player.kevlar = this.playerArmor.kevlar;
      this.player.helmet = this.playerArmor.helmet;
      this.audio.pickup?.();
      this.ui.note('REDEPLOYED — STAY SHARP', 'warn');
    }, 4000);
  }

  selectThrowableSlot(slot) {
    const type = this.throwableSlots[slot];
    if (!type || this.throwables[type] <= 0 || !this.player.alive) { this.audio.ui('deny'); return; }
    this.selectedThrowable = slot;
    this.currentThrowable = type;
    this.ui.note(`THROWABLE: ${type.toUpperCase()} (slot ${slot + 1})`, '');
  }
  throwThrowable() {
    const slot = this.selectedThrowable;
    if (slot < 0) return;
    const t = this.throwableSlots[slot];
    if (!t || this.throwables[t] <= 0 || this.grenadeCd > 0 || !this.player.alive) { this.audio.ui('deny'); return; }
    this.throwables[t]--; this.grenadeCd = 0.9;
    const cam = this.viewCamera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const from = cam.getWorldPosition(new THREE.Vector3()).addScaledVector(dir, 0.35);
    const vel = dir.clone().multiplyScalar(15).add(new THREE.Vector3(0, 3.2, 0));
    const model = this.throwModels[t] || null;
    let fuse = 2.4, dmg = 120, radius = 7.5;
    if (t === 'smoke_bomb') { fuse = 1.5; dmg = 0; radius = 9; }
    else if (t === 'flashbang') { fuse = 1.8; dmg = 0; radius = 10; }
    else if (t === 'grenade') { fuse = 2.4; dmg = 120; radius = 7.5; }
    this.grenades.throw(vel, from, { enemy: false, fuse, dmg, radius, throwable: t, model });
    const names = { smoke_bomb: 'SMOKE OUT', flashbang: 'FLASH OUT', grenade: 'FRAG OUT' };
    this.ui.note(names[t], 'warn');
    // auto-switch back to primary when out of this throwable
    if (this.throwables[t] <= 0) {
      this.throwableSlots.splice(slot, 1);
      if (this.selectedThrowable >= this.throwableSlots.length) this.selectedThrowable = this.throwableSlots.length - 1;
      if (this.selectedThrowable < 0) { this.selectedThrowable = -1; this.guns.equipSlot(0, true); }
    }
  }
  melee() {
    if (this.meleeCd > this.time) return;
    this.meleeCd = this.time + 0.7;
    this.audio.shot('pistol', null);
    this.viewmodel.fireKick(1.4);
    const cam = this.viewCamera;
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const dir = cam.getWorldDirection(new THREE.Vector3());
    for (const e of this.enemies) {
      if (e.dead) continue;
      const to = e.pos.clone().add(new THREE.Vector3(0, 1, 0)).sub(origin);
      if (to.length() < 2.4 && to.normalize().dot(dir) > 0.6) {
        const killed = e.hit(120, e.pos, dir, false);
        this.audio.hitmarker(true); this.ui.hitmarker(true, killed);
        if (killed) this.onEnemyKilled(e, false);
        this.player.shake = 1;
        break;
      }
    }
  }
  toggleDefuse() {
    if (this.mode !== 'game' || !this.waveDefuseUnlocked) return;
    const p = this.player;
    let armedNode = null, armedDist = Infinity;
    for (let i = 0; i < this.objectives.length; i++) {
      const o = this.objectives[i], node = this.nodes[i];
      const d = Math.hypot(p.pos.x - o.pos.x, p.pos.z - o.pos.z);
      if (o.armed && node.armed && d < armedDist) { armedDist = d; armedNode = node; }
    }
    if (!armedNode || armedDist > 3.2) return;
    if (armedNode.defusing) {
      armedNode.stopDefuse();
      this.ui.note('DEFUSE INTERRUPTED', 'bad');
      this.defuseProgress = 0;
    } else {
      armedNode.startDefuse();
      this.ui.note('DEFUSING… STAY CLOSE', 'warn');
    }
  }
  explode(pos, dmg, radius, enemy, throwable) {
    const pd = this.player.pos.clone().add(new THREE.Vector3(0, 1, 0)).distanceTo(pos);
    if (pd < radius + 1) {
      const fall = 1 - clamp(pd / (radius + 1), 0, 1);
      if (!this.level.losBlocked(pos, this.player.pos.clone().add(new THREE.Vector3(0, 1, 0))) || pd < 2.2) {
        // flashbang blinds player briefly
        if (throwable === 'flashbang' && !enemy) this.player.shake = Math.min(2.5, this.player.shake + 1.5);
        if (!enemy) this.damagePlayer(dmg * fall * 0.9, pos);
        else this.damagePlayer(dmg * fall, pos);
      }
    }
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = e.pos.clone().add(new THREE.Vector3(0, 1, 0)).distanceTo(pos);
      if (d > radius) continue;
      const fall = 1 - clamp(d / radius, 0, 1);
      const killed = e.hit(dmg * fall * (enemy ? 0.45 : 1), e.pos, pos.clone().sub(e.pos).normalize(), false);
      if (killed && !enemy) this.onEnemyKilled(e, false);
    }
    // camera shake
    const dist = this.player.pos.distanceTo(pos);
    this.player.shake = Math.min(1.6, this.player.shake + clamp(1.4 - dist / 12, 0, 1.4));
    // smoke screen effect
    if (throwable === 'smoke_bomb') {
      this.fx.smoke(pos, radius);
    }
  }

  /* ===================== mission flow ===================== */
  completeObjective(node) {
    node.arm();
    node.def.armed = true;
    this.stats_run.score += 500;
    this.audio.objective(true);
    this.ui.note(node.def.name + ' DESTROYED', 'warn');
    setTimeout(() => {
      this.fx.explosion(node.group.position.clone().add(new THREE.Vector3(0, 0.7, 0)), 5);
      this.audio.explosion(node.group.position);
    }, 700);
    // reinforcements are alerted to the breach
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.alertness = 1;
      e.lastSeen.copy(this.player.pos);
      e.squad?.reportSighting(e, this.player.pos);
      if (e.state === 'patrol') e.setPathTo(this.player.pos, 'investigate');
    }
    if (this.objectives.every(o => o.armed)) {
      setTimeout(() => this.finishDebrief(true), 1600);
    }
  }
  finishDebrief(won) {
    if (this.mode === 'debrief') return;
    this.mode = 'debrief';
    this.resetInput();
    document.exitPointerLock?.();
    this.ui.setHud(false);
    if (won) this.stats_run.score += 1000;
    this.stats_run.acc = this.stats_run.hits / Math.max(1, this.stats_run.shots);
    this.stats.ops++; this.stats.best = Math.max(this.stats.best, this.stats_run.score);
    this.save();
    this.audio.setCombatMusic(false);
    this.audio.startMusic();
    this.ui.showDebrief({
      stats: this.stats_run, missionTime: this.missionTime,
      get objectives() { return this.objectives; },
    }, won);
  }
  resetInput() {
    this.keys = {};
    this.mouse.down = false; this.mouse.pressed = false;
    this.mouse.dx = 0; this.mouse.dy = 0;
    this.setAds(false);
    this.player.wantLean = 0;
    this.accum = 0;
  }
  pause(fromLockLoss = false) {
    if (this.mode !== 'game') return;
    this.resetInput();
    if (this._shopOpen) { this._shopOpen = false; this.ui.setShopGame(false); }
    this.mode = 'paused';
    this.ui.show('pause');
    this.ui.setHud(false);
    document.exitPointerLock?.();
    this.audio.setCombatMusic(false);
  }
  resume() {
    if (this.mode !== 'paused') return;
    this.mode = 'game';
    if (!this.activeCamera) this.activeCamera = this.viewCamera;
    this.ui.hideAll();
    this.ui.setHud(true);
    this._lockPointer();
    this.audio.setCombatMusic(true);
    this.clock.getDelta();
  }
  openPauseSettings() { this.ui.show('settings'); }
  restart() {
    this.audio.ui('click');
    this.startGame(this.selectedMap, this.gameMode || 'breach', Object.keys(DIFFICULTY).find(k => DIFFICULTY[k] === this.diff) || 'operator');
  }

  /* ===================== in-game shop (CS2 style) ===================== */
  toggleShop() {
    // open while deployed OR paused, and also work on the key-repeat-safe path
    if (this.mode === 'paused' && !this._shopOpen) { this.mode = 'game'; this.ui.hideAll(); this.ui.setHud(true); }
    if (this.mode !== 'game') return;
    this._shopOpen = !this._shopOpen;
    this.ui.setShopGame(this._shopOpen);
    if (this._shopOpen) { this.resetInput(); this.audio.ui('click'); document.exitPointerLock?.(); }
    else { this.audio.ui('back'); this._lockPointer(); }
  }
  buyWeapon(id) {
    try {
      let d = WEAPONS[id];
      let isShopItem = false;
      if (!d) {
        d = SHOP_ITEMS[id];
        isShopItem = true;
      }
      if (!d) { this.ui.note('ITEM NOT FOUND', 'bad'); return; }
      if (this.cash.amount < d.price) { this.ui.note('NOT ENOUGH CASH', 'bad'); return; }

      if (isShopItem) {
        if (d.type === 'armor') {
          const have = (this.playerArmor[d.id] || 0) > 0;
          if (have) { this.ui.note('ALREADY OWNED', 'bad'); return; }
          this.cash.amount -= d.price;
          this.playerArmor[d.id] = 1;
          localStorage.setItem('bp_cash', JSON.stringify(this.cash));
          this.save();
          this.audio.ui('click');
          this.ui.note(`BOUGHT ${d.name} · $${d.price}`, 'warn');
          this.ui.setShopGame(true);
          return;
        }
        if (d.type === 'health') {
          const healed = this.player.heal ? this.player.heal(50) : 0;
          if (!healed && !this.player.alive) { this.ui.note('DEAD — NO HEAL', 'bad'); return; }
          this.cash.amount -= d.price;
          localStorage.setItem('bp_cash', JSON.stringify(this.cash));
          this.save();
          this.audio.ui('click');
          this.ui.note(`HEALED +50 HP · $${d.price}`, 'warn');
          this.ui.setShopGame(true);
          return;
        }
        if (d.type === 'throwable') {
          const maxOwned = 3;
          const have = (this.throwables[d.id] || 0) >= maxOwned;
          if (have) { this.ui.note('MAX STOCK REACHED', 'bad'); return; }
          this.cash.amount -= d.price;
          this.throwables[d.id] = (this.throwables[d.id] || 0) + 1;
          // add to inventory slot list on first purchase of this type
          if (!this.throwableSlots.includes(d.id)) this.throwableSlots.push(d.id);
          // auto-select if nothing selected yet
          if (this.selectedThrowable < 0) this.selectedThrowable = 0;
          localStorage.setItem('bp_cash', JSON.stringify(this.cash));
          this.save();
          this.audio.ui('click');
          this.ui.note(`BOUGHT ${d.name} · $${d.price}`, 'warn');
          this.ui.setShopGame(true);
          return;
        }
      }

      // weapon
      const have = this.cash.owned && this.cash.owned[id];
      const free = id === 'm4' || id === 'p226';
      if (have || free) {
        this.equipWeapon(id);
        this.audio.ui('click');
        this.ui.note(free ? `CLAIMED ${WEAPONS[id].short}` : `EQUIPPED ${WEAPONS[id].short}`, '');
        return;
      }
      this.cash.amount -= d.price;
      if (!this.cash.owned) this.cash.owned = {};
      this.cash.owned[id] = true;
      localStorage.setItem('bp_cash', JSON.stringify(this.cash));
      this.save();
      this.equipWeapon(id);
      this.audio.ui('click');
      this.ui.note(`BOUGHT ${WEAPONS[id].short} · $${d.price}`, 'warn');
      this.ui.setShopGame(true);
    } catch (e) { console.error('buyWeapon failed', e); this.ui.note('PURCHASE FAILED', 'bad'); }
  }
  equipWeapon(id) {
    const slot = WEAPONS[id].slot;
    this.loadout[slot === 0 ? 'primary' : 'secondary'] = id;
    this.guns.equipSlot(slot, true);
    this.viewmodel.equip(id);
    this.guns.def = WEAPONS[id];
    this.ui.note(`EQUIPPED ${WEAPONS[id].short}`, '');
  }
  abortToMenu() {
    this.mode = 'menu';
    this.ui.setHud(false);
    this.wave = 0; this.waveActive = false; this.waveDefuseUnlocked = false;
    this.waveEnemyCount = 0; this.waveCountdownT = 0; this.waveEnemies = [];
    // fully reset input/mouse/throwable state so a redeploy can't inherit a stuck
    // "shooting" or "throwable selected" state that blocks the gun
    this.mouse.down = false; this.mouse.pressed = false;
    this.selectedThrowable = -1;
    this.currentThrowable = 'grenade';
    document.exitPointerLock?.();
    this.guns.loadout = { primary: this.loadout.primary, secondary: this.loadout.secondary };
    this.guns.slot = 1; this.guns.def = null;
    document.getElementById('hud').style.opacity = '1';
    for (const e of this.enemies) { if (e.dispose) e.dispose(); else this.scene.remove(e.root); }
    this.enemies = []; this.nodes.forEach(n => n.dispose(this.scene)); this.nodes = [];
    this.level.unload();
    this.scene.fog = null;
    this.grenades?.clear();
    this.audio.setCombatMusic(false);
    this.audio.startMusic();
    this.ui.show('menu');
    this.updateMenuStats();
    this.buildMenuBackdrop(this.ui.selectedMap);
  }

  /* ===================== misc hooks used by AI/UI ===================== */
  onCallout(enemy, text) {
    this.audio.callout(enemy.pos);
    this.ui.note(text, 'bad');
  }
  onEnemyDie(enemy) {
    if (!this.waveActive) return;
    const i = this.waveEnemies.indexOf(enemy);
    if (i >= 0) this.waveEnemies.splice(i, 1);
    // recount from actual live enemies so grenade/explosive kills always count
    this.waveEnemyCount = this.waveEnemies.length;
    // wave cleared: start next wave or unlock defuse after wave 3
    if (this.waveEnemyCount <= 0) {
      this.waveActive = false;
      if (this.wave < 3) {
        this.waveCountdownT = 10;
        this.ui.note(`WAVE ${this.wave} CLEARED — BUY STUFF · NEXT WAVE IN 10s`, 'warn');
      } else {
        if (this.endlessMode) {
          this.wave = 0; this.waveCountdownT = 10; this.waveActive = false;
          this.waveDefuseUnlocked = false;
          this.ui.note(`ALL WAVES CLEARED — ENDLESS WAVE ${this.wave + 1} INCOMING`, 'warn');
        } else {
          this.waveDefuseUnlocked = true;
          this.ui.note(`ALL WAVES CLEARED — DEFUSE THE BOMB`, 'warn');
          // arm only ONE bomb (nearest objective to player)
          const p = this.player;
          let nearest = null, nearestD = 1e9;
          for (const o of this.objectives) {
            if (o.armed) continue;
            const d = Math.hypot(o.pos.x - p.pos.x, o.pos.z - p.pos.z);
            if (d < nearestD) { nearestD = d; nearest = o; }
          }
          if (nearest) {
            nearest.armed = true;
            const node = this.nodes[this.objectives.indexOf(nearest)];
            node.arm();
          }
        }
      }
    }
  }
  startWave(n) {
    this.wave = n; this.waveActive = true; this.waveStartT = this.time;
    const count = 5 + (n - 1) * 2; // wave 1 = 5, wave 2 = 7, wave 3 = 9
    const squads = this.squads;
    const spawnCells = this.level.enemySpawns;
    const used = [];
    const sp = this.player.pos;
    const pick = (minFromPlayer, minFromFriend) => {
      for (let tries = 0; tries < 80; tries++) {
        const c = spawnCells[(Math.random() * spawnCells.length) | 0];
        const w = this.level.nav.cellToWorld(c);
        if (Math.hypot(w.x - sp.x, w.z - sp.z) < minFromPlayer) continue;
        if (used.some(u => Math.hypot(u.x - w.x, u.z - w.z) < minFromFriend)) continue;
        used.push(w); return c;
      }
      return -1;
    };
    this.ui.note(`WAVE ${n} — ${count} HOSTILES`, 'warn');
    // delete corpses from previous waves so they don't accumulate and lag the game
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead) {
        e.dispose?.();
        e.root.parent?.remove(e.root);
        this.enemies.splice(i, 1);
      }
    }
    for (let k = 0; k < count; k++) {
      const sq = squads[k % 3];
      let cell = pick(16, 7);
      if (cell < 0) cell = pick(12, 5);
      if (cell < 0) cell = pick(9, 4);
      if (cell < 0) cell = spawnCells[(Math.random() * spawnCells.length) | 0];
      const soldier = buildSoldier(this.soldierGLTF);
      soldier.model.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; });
      const e = new Enemy(this, soldier.model, sq);
      e.parts = soldier.parts; e.materials = soldier.materials;
      e.mixer = soldier.mixer; e.anims = soldier.anims;
      if (e.mixer && e.anims.run) e.anims.run.setLoop(THREE.LoopRepeat);
      e.model.userData.soldier = soldier;
      this.scene.add(e.root);
      const eEnv = this.scene.environment;
      if (eEnv) {
        e.root.traverse(o => {
          if (o.isMesh && o.material && o.material.envMap !== undefined && !o.material.envMap) {
            o.material.envMap = eEnv;
            o.material.envMapIntensity = 1.0;
            o.material.needsUpdate = true;
          }
          o.visible = true;
          o.frustumCulled = false;
        });
      }
      const w = this.level.nav.cellToWorld(cell);
      e.pos.set(w.x, this.level.nav.floor[cell] || 0, w.z);
      e.root.position.copy(e.pos);
      e.yaw = Math.random() * Math.PI * 2;
      e.crouch = 0; e.lean = 0; e.anim.aimPitch = 0;
      sq.add(e);
      this.waveEnemies.push(e);
      this.waveEnemyCount++;
      this.enemies.push(e);
    }
    this.ui.setWave(this.wave, this.waveEnemyCount);
  }
  rayHitWorld(origin, dir, maxDist) { return this.level.raycast(origin, dir, maxDist); }
  get nav() { return this.level.nav; }
  get colliders() { return this.level.colliders; }
  losBlocked(a, b) { return this.level.losBlocked(a, b); }

  /* ===================== frame ===================== */
  loop() {
    requestAnimationFrame(this.loop);
    const rawDt = Math.min(0.1, this.clock.getDelta());
    this.fpsAcc += rawDt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) { this.fps = Math.round(this.fpsFrames / this.fpsAcc); this.ui.setFps(this.fps); this.fpsAcc = 0; this.fpsFrames = 0; }
    const dt = rawDt;

    if (this.mode === 'game') {
      // fixed-step physics: identical feel at 60/144/240 Hz and no tunnelling through
      // geometry on a frame hitch (every step advances <= 1/90 s of simulation)
      this.accum = Math.min(0.1, (this.accum || 0) + dt);
      const FIXED = 1 / 90;
      let steps = 0;
      while (this.accum >= FIXED && steps < 6) {
        try { this.updateGame(FIXED); } catch (e) { console.error('updateGame crashed', e); }
        this.accum -= FIXED; steps++;
      }
      if (steps === 6) this.accum = 0;
      if (steps === 0) { this.renderFrame(); return; }
    }
    else if (this.mode === 'menu' || this.mode === 'boot') this.updateMenu(dt);
    else if (this.mode === 'debrief' || this.mode === 'paused') this.renderActive(dt);
    try { this.renderFrame(); } catch (e) { console.error('renderFrame crashed', e); }
  }
  renderFrame() {
    // --- GREY VOID GUARD ----------------------------------------------
    // A lost WebGL context (driver reset, tab backgrounded under memory pressure,
    // too many live renderers) renders a flat grey frame: the UI keeps working
    // while the canvas goes blank. Detect it, force three's restore handshake and
    // if the context cannot come back, reload the page — the operator redeploys
    // instead of staring at a dead screen.
    {
      const gl = this.renderer.getContext?.();
      if (gl && gl.isContextLost && gl.isContextLost()) {
        if (!this._ctxLostT) {
          this._ctxLostT = performance.now();
          console.warn('[bp] WebGL context lost — attempting restore');
          gl.getExtension('WEBGL_lose_context')?.restoreContext();
        } else if (performance.now() - this._ctxLostT > 2500) {
          location.reload();
          return;
        }
        return; // skip drawing until the context is back
      } else if (this._ctxLostT) { this._ctxLostT = 0; console.info('[bp] WebGL context restored'); }
    }
    // --- GREY VOID FIX ------------------------------------------------
    // In-game the operator camera lives in the scene and the map root is its
    // sibling. Anything that leaves world matrices stale/re-dirty between the
    // world pass and the gun pass makes the map appear as a flat void while
    // the HUD, enemies and audio keep running. Refresh the world transforms
    // exactly once, right before the world is drawn, and then draw the gun
    // pass with the world detached from the graph instead of toggling
    // visibility on hundreds of objects (which mutates the children arrays
    // three is iterating over).
    if (this.mode === 'game') {
      this.activeCamera = this.viewCamera;
      // keep the camera world matrix current before every render pass
      this.viewCamera.updateMatrixWorld(true);
      // safety: if the camera position ever goes invalid, reset to the player
      if (!isFinite(this.viewCamera.position.x) || !isFinite(this.viewCamera.position.y) || !isFinite(this.viewCamera.position.z)) {
        this.viewCamera.position.copy(this.player.pos).add(new THREE.Vector3(0, this.player.eyeHeight, 0));
        this.viewCamera.rotation.set(0, this.player.yaw, 0, 'YXZ');
        this.viewCamera.updateMatrixWorld();
      }
      // guarantee scene environment + exposure every frame so PBR materials never
      // read black and the world never drops into a grey void, even if a prior
      // dispose nulled the env map or a frame hitch left shadows stale
      if (!this.scene.environment) {
        if (!this._envFallback) {
          const env = new THREE.Scene();
          env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.BackSide })));
          const pmrem = new THREE.PMREMGenerator(this.renderer);
          this._envFallback = pmrem.fromScene(env, 0.25).texture;
          pmrem.dispose();
        }
        this.scene.environment = this._envFallback;
        this.scene.environmentIntensity = 1.0;
      }
      // exposure: always restore the map's authored value (never let it drift to zero/black)
      const pres = this.level?.presentation;
      const exposure = pres ? (pres.exposure || 1.05) : (this.level?.def ? MAPS[this.level.def.id]?.exposure || 1.05 : 1.05);
      this.renderer.toneMappingExposure = Math.max(exposure || 1.05, 1.2) * Math.max(this.settings.gamma || 1.0, 0.5);
      // shadows are live via shadowMap.autoUpdate = true; never force needsUpdate per-frame
    }
    const worldCam = this.activeCamera || this.camera;
    worldCam.updateMatrixWorld();
    // PERF: cache the viewmodel light list once — the per-frame children.filter()
    // allocated a fresh array every single frame (~144 allocs/s for nothing).
    if (this.viewmodel?.root && !this._vmLights) {
      this._vmLights = this.viewmodel.root.children.filter(o => o.isLight);
    }
    if (this._vmLights) for (const l of this._vmLights) l.visible = false;
    // draw the world with the operator camera (never culls the map)
    this.renderer.render(this.scene, worldCam);
    // viewmodel pass: draw the gun on top without hiding anything in the world
    if (this.mode === 'game' && this.viewmodel.loaded && this.viewmodel.current && worldCam === this.viewCamera) {
      const auto = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      // render just the viewmodel gun root so it never clips through walls but
      // never touches scene visibility (the map stays drawn)
      if (this.viewmodel.root) this.renderer.render(this.viewmodel.root, this.viewCamera);
      this.renderer.autoClear = auto;
    }
    // ABSOLUTE SAFETY: in-game nothing may stay hidden — force every scene child
    // visible (except the operator camera itself) so the map can never vanish
    if (this.mode === 'game') {
      for (const c of this.scene.children) {
        if (c === this.viewCamera) continue;
        c.visible = true;
      }
      if (this._deployLight) this._deployLight.visible = true;
      if (this._deployPl) this._deployPl.visible = true;
    }
    this.mouse.dx = 0; this.mouse.dy = 0;
  }
  /** dynamic resolution: holds 60fps on weaker GPUs, spends the headroom on a sharp image when there is any */
  autoQuality() {
    if (this.settings.autoQuality === false) return;
    this.qAcc = (this.qAcc || 0) + 1;
    if (this.qAcc < 360) return; // only re-evaluate every ~6s — avoids per-frame GPU buffer rebuilds
    this.qAcc = 0;
    const ms = this.fps > 0 ? 1000 / this.fps : 16;
    // Only act on clear, sustained FPS problems (not momentary hitches)
    const slow = ms > 30;   // FPS < 33
    const fast = ms < 11;   // FPS > 90
    let scale = this._dynScale || 1;
    if (slow && scale > 0.5) scale = Math.max(0.5, scale - 0.1);
    else if (fast && scale < 1) scale = Math.min(1, scale + 0.1);
    // Apply only when the difference is significant; small steps don't justify a GPU stall
    if (Math.abs(scale - (this._dynScale || 1)) > 0.08) {
      this._dynScale = clamp(scale, 0.5, 1);
      // NOTE: never call setPixelRatio() mid-gameplay — it reallocates the WebGL
      // drawing buffer and is the #1 cause of the grey-blank-screen bug. Pixel
      // ratio is set once at deploy (constructor) and on window resize.
    }
  }
  renderActive(dt) {
    if (this.level.map) this.level.update(dt);
    if (this.fx) this.fx.update(dt);
    if (this.activeCamera === this.viewCamera && this.player.alive) { /* keep camera still */ }
  }

  updateMenu(dt) {
    this.time += dt;
    if (!this.menuLevel) { this.activeCamera = this.camera; return; }
    this.menuLevel.update(dt);
    const o = this.menuOrbit;
    if (o) {
      o.a += dt * 0.045;
      const cx = o.cx + Math.cos(o.a) * o.r, cz = o.cz + Math.sin(o.a) * o.r;
      const y = o.y + Math.sin(this.time * 0.3) * 1.4;
      this.camera.position.lerp(this._tmpV.set(cx, y, cz), 1 - Math.exp(-1.5 * dt));
      const look = this._tmpV2.set(o.cx, 1.5 + Math.sin(this.time * 0.2) * 0.6, o.cz);
      this.camera.lookAt(look);
    }
    // live feel: a slow drift so the "feed" never looks frozen
    this.camera.rotation.z = Math.sin(this.time * 0.2) * 0.01;
    this.activeCamera = this.camera;
    this.camera.fov = this.settings.fov;
  }

  updateGame(dt) {
    this.time += dt;
    if (this.player.alive) this.missionTime += dt;
    // wave breather between waves (10-second countdown to buy)
    if (!this.waveActive && this.wave < 3) {
      if (this.waveEnemyCount <= 0 && this.waveCountdownT <= 0) {
        this.waveCountdownT = 10;
        this.ui.note(`WAVE ${this.wave} CLEARED — NEXT WAVE IN 10s`, 'warn');
      }
      if (this.waveCountdownT > 0) {
        this.waveCountdownT -= dt;
        if (this.waveCountdownT <= 0) {
          this.startWave(this.wave + 1);
          this.ui.note(`WAVE ${this.wave} — INCOMING`, 'warn');
        }
      }
    }
    const p = this.player;
    const k = this.keys;
    // input mapping
    const inp = this.input;
    const kb = this.settings.keybinds;
    inp.f = k.KeyW ? 1 : 0; inp.b = k.KeyS ? 1 : 0;
    inp.l = k.KeyA ? 1 : 0; inp.r = k.KeyD ? 1 : 0;
    inp.jump = !!k.Space; inp.sprint = !!(k.ShiftLeft || k.ShiftRight);
    inp.crouch = !!(k.ControlLeft || k.ControlRight || k.KeyC);
    p.wantLean = k[kb.leanLeft] ? -1 : k[kb.leanRight] ? 1 : 0;

    this.playerNoise = Math.max(0, this.playerNoise - dt * 2);
    if (inp.sprint && Math.hypot(p.vel.x, p.vel.z) > 5) this.playerNoise = Math.max(this.playerNoise, 0.35);

    p.update(dt, inp, this.level.colliders, this.audio);
    // recoil decay is advanced by the player's camera update each frame
    p.updateRecoil(dt);

    // ---- ADS / fov
    const wantAds = this.mouse.ads && !this.guns.reloading;
    this.guns.setAdsWant(wantAds ? 1 : 0);
    const targetFov = wantAds ? this.guns.def.adsFov : this.settings.fov;
    const nf = THREE.MathUtils.damp(this.viewCamera.fov, targetFov, 14, dt);
    // only touch the projection matrix when it actually changed (it is a per-PSO rebuild otherwise)
    if (Math.abs(nf - this.viewCamera.fov) > 1e-3) {
      this.viewCamera.fov = nf;
      this.viewCamera.near = wantAds && this.guns.def?.scope ? 0.02 : 0.01;
      this.viewCamera.updateProjectionMatrix();
    }

    // ---- gun / throwable
    this.guns.update(dt, this.time);
    if (this.mouse.ads && this.guns.reloading) this.mouse.ads = this.mouse.ads;
    const shoot = this.mouse.down || this.mouse.pressed;
    if (shoot) {
      if (this.selectedThrowable >= 0) this.throwThrowable();
      else this.guns.tryFire(this.time, this.mouse.pressed);
    }
    this.mouse.pressed = false;
    this.grenadeCd = Math.max(0, this.grenadeCd - dt);

    // ---- viewmodel
    const vm = this.viewmodel;
    if (vm.def !== this.guns.def) vm.equip(this.guns.def.id);
    vm.adsWant = wantAds ? 1 : 0;
    vm.update(dt, p, this.mouse.down, p.sprint, this.guns.reloading, this.mouse.dx, this.mouse.dy);

    // ---- world systems
    this.level.update(dt, p.pos);
    this.fx.update(dt);
    this.grenades.update(dt);
    // keep deploy lights locked to the operator so the world never goes dark
    if (this._deployLight) { this._deployLight.intensity = 3.0; }
    if (this._deployPl) {
      this._deployPl.position.copy(p.pos); this._deployPl.position.y += 1.0;
      this._deployPl.intensity = 12.0;
    }

    // ---- squads & enemies
    for (const sq of this.squads) sq.update(dt);
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      this.enemies[i].update(dt, p);
    }
    // last-enemies alert: blink red through walls when <= 2 hostiles remain
    const aliveCount = this.enemies.filter(e => !e.dead).length;
    this.lowEnemyAlert = aliveCount > 0 && aliveCount <= 2;
    this.lowEnemyPulse = Math.sin(this.time * 10) > 0;
    // PERF: dead enemies' models cost per-frame skinning + matrix updates for zero
    // gameplay value. Corpses are already static: stop their whole update after the
    // death animation settles (the node itself is removed from the update list).
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead && e.deathT > 3 && !e._frozen) {
        e._frozen = true;
        e.root.traverse(o => { o.matrixAutoUpdate = false; });
        e.root.updateMatrixWorld(true);
      }
    }

    // ---- objectives (relay nodes) + bomb defuse
    // Defuse is a proximity HOLD: stand near the armed bomb for 3 s. Nothing
    // previously called startDefuse/updateDefuse, so the bomb could never be
    // defused and the mission could never be won.
    let nearObj = null;
    let armedNode = null, armedDist = Infinity;
    for (let i = 0; i < this.objectives.length; i++) {
      const o = this.objectives[i], node = this.nodes[i];
      node.update(dt, this.time, p.pos);
      const d = Math.hypot(p.pos.x - o.pos.x, p.pos.z - o.pos.z);
      if (d < 3.2) nearObj = o;
      if (o.armed && node.armed && d < armedDist) { armedDist = d; armedNode = node; }
    }
    if (this.waveDefuseUnlocked && armedNode) {
      const IN_RANGE = 3.2;
      if (armedDist <= IN_RANGE && p.alive && armedNode.defusing) {
        this.defuseProgress = armedNode.defuseT / 3.0;
        if (armedNode.updateDefuse(dt)) {
          // bomb defused: mission complete
          this.defuseProgress = 0;
          this.audio.objective(true);
          this.ui.note('BOMB DEFUSED — OPERATION COMPLETE', 'warn');
          this.stats_run.score += 1000;
          setTimeout(() => this.finishDebrief(true), 1200);
        }
      } else {
        if (armedNode.defusing) { armedNode.stopDefuse(); this.ui.note('DEFUSE INTERRUPTED — GET CLOSER', 'bad'); }
        this.defuseProgress = 0;
      }
    } else this.defuseProgress = 0;
    this.promptText = armedNode && armedNode.defusing
      ? `DEFUSING ${Math.round(this.defuseProgress * 100)}%`
      : (this.waveDefuseUnlocked && armedNode && armedDist <= 6 ? 'MOVE TO THE BOMB TO DEFUSE' : null);
    // ---- bomb countdown: if the timer expires, the mission is LOST
    if (armedNode && armedNode.explodeT > 0 && armedNode.armed) {
      armedNode.explodeT -= dt;
      if (armedNode.explodeT <= 0) {
        armedNode.explodeT = 0;
        this.ui.note('THE BOMB DETONATED — OPERATION FAILED', 'bad');
        this.fx.explosion(armedNode.group.position.clone().add(new THREE.Vector3(0, 0.7, 0)), 6);
        this.audio.explosion(armedNode.group.position);
        setTimeout(() => this.finishDebrief(false), 1200);
      }
    }

    // ---- camera & shake
    this.activeCamera = this.viewCamera;
    if (this.settings.shake && this.recoilCam > 0.0005) {
      this.viewCamera.rotation.x += (Math.random() - 0.5) * this.recoilCam;
      this.viewCamera.rotation.y += (Math.random() - 0.5) * this.recoilCam;
      this.recoilCam *= Math.exp(-13 * dt);
    } else this.recoilCam = 0;
    // death cam: slump and look at the floor
    if (!p.alive) {
      this.viewCamera.position.y = THREE.MathUtils.damp(this.viewCamera.position.y, p.pos.y + 0.25, 4, dt);
      this.viewCamera.rotation.z = THREE.MathUtils.damp(this.viewCamera.rotation.z, 0.9, 3, dt);
      this.viewCamera.rotation.x = THREE.MathUtils.damp(this.viewCamera.rotation.x, -0.2, 3, dt);
      // PERF: setting the same style value every frame forces a style recalc;
      // only touch the DOM when the state actually flips.
      if (!this._hudOpacityForced) { document.getElementById('hud').style.opacity = '1'; this._hudOpacityForced = true; }
    } else this._hudOpacityForced = false;

    // ---- hud
    // Presentational only: a missing/broken HUD element must never abort the
    // simulation. Before this guard, a null element inside updateHud threw here
    // every fixed step, killing physics/camera/recoil for the whole session.
    try { this.ui.updateHud(this); } catch (e) { if (!this._hudErrShown) { this._hudErrShown = true; console.warn('updateHud failed (game continues)', e); } }

    // ---- combat music: rises while enemies know where you are
    this.combatMusicT -= dt;
    if (this.combatMusicT <= 0) {
      this.combatMusicT = 2;
      const engaged = this.enemies.some(e => !e.dead && (e.seenNow || e.state === 'engage' || e.state === 'rush'));
      this.audio.setCombatMusic(engaged);
    }
  }
}

const _shotC = new THREE.Vector3();
function raySphere(o, d, c, r, maxT) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return null;
  const t = -b - Math.sqrt(h);
  if (t < 0.02 || t > maxT) return null;
  return t;
}

// boot the game once the DOM + fonts are ready
window.addEventListener('load', () => {
  try {
    window.game = new Game();
  } catch (e) {
    window.__BP_BOOT_ERROR = (e && (e.stack || e.message)) || String(e);
    console.error('BREACHPOINT failed to start', e);
    document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:0;z-index:999;color:#ff4a3d;background:#000;padding:20px;font:12px monospace;overflow:auto">${e.stack || e}</pre>`);
  }
});
