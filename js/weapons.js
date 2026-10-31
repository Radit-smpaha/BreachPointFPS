// BREACHPOINT — weapon data, viewmodel handling and the player's ballistics gun system
import * as THREE from 'three';

export const WEAPONS = {
  m4: {
    id: 'm4', name: 'M4A1 CARBINE', short: 'M4A1', cls: 'ASSAULT RIFLE', file: 'M4A1_Carbine.glb', slot: 0,
    dmg: 26, head: 2.6, rpm: 720, mag: 30, reserve: 180, auto: true, spread: 0.009, adsSpread: 0.0022, len: 0.45, adsY: 0.05,
    recoil: [0.0085, 0.004], kick: 1, reload: 2.0, adsFov: 55, falloff: [28, 80], caliber: '5.56×45',
    scale: 1.0, pos: [0.19, -0.2, -0.5], rot: [0, 0, 0], adsPos: [0, 0.015, -0.4], adsFov: 55,
    sound: 'rifle', price: 0, stats: { DMG: 5, RATE: 7, ACC: 8, RNG: 7, CTL: 7 }, attrs: { VELOCITY: '880 m/s', CAPACITY: '30 + 180', FIRE: 'AUTO' },
  },
  ak: {
    id: 'ak', name: 'AK-12 RIFLE', short: 'AK-12', cls: 'ASSAULT RIFLE', file: 'AK12_Rifle.glb', slot: 0,
    dmg: 34, head: 2.4, rpm: 600, mag: 30, reserve: 180, auto: true, spread: 0.014, adsSpread: 0.003, len: 0.5, adsY: 0.05,
    recoil: [0.015, 0.007], kick: 1.35, reload: 2.3, adsFov: 56, falloff: [30, 85], caliber: '5.45×39',
    scale: 1.0, pos: [0.19, -0.2, -0.5], rot: [0, 0, 0], adsPos: [0, 0.015, -0.4], adsFov: 56,
    sound: 'rifle', price: 4500, stats: { DMG: 7, RATE: 6, ACC: 6, RNG: 8, CTL: 5 }, attrs: { VELOCITY: '900 m/s', CAPACITY: '30 + 180', FIRE: 'AUTO' },
  },
  mp7: {
    id: 'mp7', name: 'MP7 SMG', short: 'MP7', cls: 'SUBMACHINE GUN', file: 'MP7.glb', slot: 0,
    dmg: 19, head: 2.2, rpm: 950, mag: 40, reserve: 200, auto: true, spread: 0.02, adsSpread: 0.005, len: 0.4, adsY: 0.045,
    recoil: [0.006, 0.0045], kick: 0.75, reload: 1.7, adsFov: 60, falloff: [18, 55], caliber: '4.6×30',
    scale: 1.0, pos: [0.19, -0.2, -0.5], rot: [0, 0, 0], adsPos: [0, 0.015, -0.4], adsFov: 60,
    sound: 'smg', price: 3000, stats: { DMG: 3, RATE: 9, ACC: 5, RNG: 3, CTL: 7 }, attrs: { VELOCITY: '720 m/s', CAPACITY: '40 + 200', FIRE: 'AUTO' },
  },
  super90: {
    id: 'super90', name: 'M4 SUPER 90', short: 'SUPER 90', cls: 'COMBAT SHOTGUN', file: 'M4_Super90.glb', slot: 0,
    dmg: 13, head: 1.8, rpm: 190, mag: 7, reserve: 42, auto: false, spread: 0.055, adsSpread: 0.04, len: 0.45, adsY: 0.05,
    pellets: 9, recoil: [0.035, 0.012], kick: 2.4, reload: 2.6, adsFov: 62, falloff: [7, 26], caliber: '12 GAUGE',
    scale: 1.0, pos: [0.19, -0.2, -0.5], rot: [0, 0, 0], adsPos: [0, 0.015, -0.4], adsFov: 62,
    sound: 'shotgun', price: 5000, stats: { DMG: 9, RATE: 2, ACC: 3, RNG: 2, CTL: 3 }, attrs: { VELOCITY: '400 m/s', CAPACITY: '7 + 42', FIRE: 'SEMI' },
  },
  awm: {
    id: 'awm', name: 'AWM SNIPER', short: 'AWM', cls: 'PRECISION RIFLE', file: 'AWM_Sniper.glb', slot: 0,
    dmg: 95, head: 3.2, rpm: 45, mag: 5, reserve: 25, auto: false, spread: 0.002, adsSpread: 0.0002, len: 0.55, adsY: 0.085,
    recoil: [0.06, 0.015], kick: 3.2, reload: 3.1, adsFov: 18, falloff: [120, 220], caliber: '.338 LAPUA', scope: true,
    scale: 1.0, pos: [0.19, -0.2, -0.5], rot: [0, 0, 0], adsPos: [0, 0.05, -0.42], adsFov: 18,
    sound: 'sniper', price: 8000, stats: { DMG: 10, RATE: 1, ACC: 10, RNG: 10, CTL: 2 }, attrs: { VELOCITY: '1050 m/s', CAPACITY: '5 + 25', FIRE: 'BOLT' },
  },
  p226: {
    id: 'p226', name: 'P226 SIDEARM', short: 'P226', cls: 'SIDEARM', file: 'p226.glb', slot: 1,
    dmg: 30, head: 2.4, rpm: 400, mag: 15, reserve: 60, auto: false, spread: 0.012, adsSpread: 0.003, len: 0.24, adsY: 0.035,
    recoil: [0.016, 0.005], kick: 1.3, reload: 1.5, adsFov: 58, falloff: [20, 55], caliber: '9×19',
    scale: 1.0, pos: [0.19, -0.2, -0.5], rot: [0, 0, 0], adsPos: [0, 0.015, -0.42], adsFov: 58,
    sound: 'pistol', price: 0, stats: { DMG: 6, RATE: 5, ACC: 7, RNG: 4, CTL: 7 }, attrs: { VELOCITY: '360 m/s', CAPACITY: '15 + 60', FIRE: 'SEMI' },
  },
  deagle: {
    id: 'deagle', name: 'DESERT EAGLE', short: 'DEAGLE', cls: 'HAND CANNON', file: 'deagle.glb', slot: 1,
    dmg: 62, head: 3.0, rpm: 190, mag: 7, reserve: 35, auto: false, spread: 0.011, adsSpread: 0.002, len: 0.28, adsY: 0.04,
    recoil: [0.045, 0.012], kick: 2.8, reload: 2.0, adsFov: 58, falloff: [40, 90], caliber: '.50 AE',
    scale: 1.0, pos: [0.19, -0.2, -0.5], rot: [0, 0, 0], adsPos: [0, 0.015, -0.42], adsFov: 58,
    sound: 'pistol', price: 2500, stats: { DMG: 9, RATE: 3, ACC: 7, RNG: 6, CTL: 2 }, attrs: { VELOCITY: '470 m/s', CAPACITY: '7 + 35', FIRE: 'SEMI' },
  },
};

/* ---------------------------------------------------------------------
   Shop items: kevlar, helmet, and throwables. slot: -1 = not a firearm.
   --------------------------------------------------------------------- */
export const SHOP_ITEMS = {
  kevlar: { id: 'kevlar', name: 'Kevlar Vest', short: 'KEVLAR', cls: 'ARMOR', price: 2500, slot: -1, type: 'armor' },
  helmet: { id: 'helmet', name: 'Helmet', short: 'HELMET', cls: 'ARMOR', price: 1500, slot: -1, type: 'armor' },
  health: { id: 'health', name: 'Health Kit', short: 'HEALTH', cls: 'CONSUMABLE', price: 1800, slot: -1, type: 'health' },
  smoke_bomb: { id: 'smoke_bomb', name: 'Smoke Bomb', short: 'SMOKE', cls: 'UTILITY', price: 800, slot: -1, type: 'throwable' },
  flashbang: { id: 'flashbang', name: 'Flashbang', short: 'FLASH', cls: 'UTILITY', price: 600, slot: -1, type: 'throwable' },
  grenade: { id: 'grenade', name: 'Frag Grenade', short: 'FRAG', cls: 'UTILITY', price: 1200, slot: -1, type: 'throwable' },
};

/* ---------------------------------------------------------------------
   Viewmodel — GLB weapon glued to the camera with springs so it feels
   weighted: sway lags the mouse, bob follows footsteps, ADS blends to
   the sight line, recoil kicks back and settles.
   --------------------------------------------------------------------- */
export class Viewmodel {
  constructor(camera, audio) {
    this.cam = camera; this.audio = audio;
    this.root = new THREE.Group();
    this.root.renderOrder = 1000;
    // the gun is drawn by a dedicated pass with its own lights, so it never pops
    // between the dark and lit sides of a map
    const key = new THREE.DirectionalLight(0xfff0d8, 2.2); key.position.set(0.6, 1.2, 0.4);
    this.root.add(key);
    const rim = new THREE.DirectionalLight(0x9db8ff, 1.6); rim.position.set(-1, 0.5, -0.8);
    this.root.add(rim);
    this.root.add(new THREE.AmbientLight(0x8d95a3, 1.1));
    this.envMap = null;
    camera.add(this.root);
    this.models = {};
    this.current = null;
    this.def = null;
    this.ads = 0; this.adsWant = 0;
    this.kick = 0; this.kickRot = 0;
    this.sway = new THREE.Vector2(); this.swayV = new THREE.Vector2();
    this.bobT = 0;
    this.reloadT = 0; this.reloadDur = 1;
    this.lower = 0; this.lowerWant = 0;
    this.muzzleOffset = new THREE.Vector3();
    this._pv = new THREE.Vector3();
    this._vmLights = null;
  }
  addModel(id, scene) {
    const def = WEAPONS[id];
    const holder = new THREE.Group();
    scene.traverse(o => {
      if (o.isMesh) {
        o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
        // Rendered in a second pass over a cleared depth buffer so the gun can never
        // clip into a nearby wall while the world keeps its proper depth testing.
        o.renderOrder = 1000;
        if (o.material) {
          o.material = o.material.clone();
          o.material.depthTest = false; o.material.depthWrite = false; o.material.fog = false;
          o.material.transparent = true;
          if (this.envMap && o.material.envMap !== undefined) { o.material.envMap = this.envMap; o.material.envMapIntensity = 1.1; }
          if (o.material.color && !o.material.map) o.material.color.multiplyScalar(1.35);
        }
      }
    });
    // centre & meausure
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    scene.position.sub(centre);
    const scale = def.scale * 0.98; // models are authored at roughly correct real-world size
    holder.add(scene);
    holder.rotation.set(def.rot[0], def.rot[1], def.rot[2]);
    holder.position.set(def.pos[0], def.pos[1], def.pos[2]);
    holder.visible = false;
    holder.frustumCulled = false;
    // Orient the model so its long axis runs down the camera's -Z (the barrel points
    // where you aim). Blender exports here run along +X, so rotate that axis onto -Z
    // (−Y rotation) instead of a sideways +Y spin, which stuck the gun out of frame.
    const axis = size.x >= size.z ? 'x' : 'z';
    const bb = new THREE.Box3().setFromObject(scene);
    const halfLen = axis === 'x' ? Math.max(-bb.min.x, bb.max.x) : Math.max(-bb.min.z, bb.max.z);
    const modelLen = Math.max(0.05, halfLen * 2);
    const s = def.len / modelLen;   // fit each weapon to its intended on-screen length
    holder.scale.setScalar(s);
    const mLocal = new THREE.Vector3(0, (bb.min.y + bb.max.y) / 2 * s, -halfLen * s - 0.03);
    // sight line: the top of the receiver in holder space. In ADS the holder is
    // positioned so this exact point sits on the camera axis = dead centre of the
    // crosshair, whatever the model's proportions are.
    const sightY = bb.max.y * s;
    // local rotate long axis -> -Z; +Z after so the muzzle faces away from the eye
    const spin = axis === 'x' ? -Math.PI / 2 : 0;
    holder.rotation.set(0, spin, 0);
    this.root.add(holder);
    this.models[id] = { holder, scene, size, basePos: new THREE.Vector3(...def.pos), baseRot: new THREE.Euler(0, spin, 0), mLocal, scale, sightY };
    return this.models[id];
  }
  equip(id) {
    for (const k in this.models) this.models[k].holder.visible = false;
    const m = this.models[id];
    if (!m) return;
    m.holder.visible = true; this.current = m; this.def = WEAPONS[id];
    this.reloadT = 0; this.lower = 0.35; this.lowerWant = 0;
  }
  startReload(dur) { this.reloadT = 0; this.reloadDur = dur; }
  fireKick(amount) { this.kick = Math.min(1.2, this.kick + 0.55 * amount); this.kickRot = Math.min(0.6, this.kickRot + 0.22 * amount); }
  muzzleWorld(out) {
    if (!this.current) return out.set(0, 0, 0);
    return out.copy(this.current.mLocal).applyMatrix4(this.current.holder.matrixWorld);
  }
  update(dt, player, firing, sprinting, reloading, mouseDX, mouseDY) {
    if (!this.current) return;
    const m = this.current, d = this.def;
    this.ads = THREE.MathUtils.damp(this.ads, this.adsWant, 16, dt);
    this.kick = THREE.MathUtils.damp(this.kick, 0, 15, dt);
    this.kickRot = THREE.MathUtils.damp(this.kickRot, 0, 14, dt);
    this.lower = THREE.MathUtils.damp(this.lower, this.lowerWant + (sprinting ? 0.65 : 0), 11, dt);
    if (reloading && !this._wasReloading) this.reloadT = 0;
    if (reloading) this.reloadT += dt;
    this._wasReloading = reloading;

    // mouse sway with spring damping
    const sx = THREE.MathUtils.clamp(-mouseDX * 0.0016, -0.09, 0.09);
    const sy = THREE.MathUtils.clamp(mouseDY * 0.0016, -0.09, 0.09);
    this.swayV.x += (sx - this.sway.x) * 90 * dt; this.swayV.x *= Math.exp(-9 * dt);
    this.swayV.y += (sy - this.sway.y) * 90 * dt; this.swayV.y *= Math.exp(-9 * dt);
    this.sway.x += this.swayV.x * dt; this.sway.y += this.swayV.y * dt;
    this.sway.x = THREE.MathUtils.clamp(this.sway.x, -0.07, 0.07);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y, -0.07, 0.07);

    // bob
    const moving = Math.hypot(player.vel.x, player.vel.z) > 1.2 && player.onGround;
    this.bobT += dt * (player.sprint ? 13 : 8.4) * (moving ? 1 : 0);
    this.bobWeight = THREE.MathUtils.damp(this.bobWeight || 0, moving ? (player.sprint ? 1.5 : 1) : 0, 10, dt);
    this.sprintWeight = THREE.MathUtils.damp(this.sprintWeight || 0, sprinting ? 1 : 0, 12, dt);
    const bobScale = this.bobWeight * (1 - this.ads * 0.85);
    const bx = Math.cos(this.bobT) * 0.012 * bobScale;
    const by = Math.abs(Math.sin(this.bobT)) * 0.010 * bobScale;

    const adsK = this.ads;
    // ADS: bring the optic to the eye line (centre the sight on the crosshair)
    const apx = 0;                       // dead centre: the sight must be ON the axis
    const apz = m.basePos.z - 0.06;      // pulled slightly closer to the eye
    // Aim alignment: the sight line = top of the receiver (measured from the model's
    // own bounding box at load time). Positioning the gun so that point sits on the
    // camera axis puts the irons/optic dead centre of the crosshair for every weapon.
    // The old `apy` also had a -0.004 constant and took sway/bob — the gun drifted
    // off-axis in ADS. At full adsK the sight must sit EXACTLY on the camera axis.
    const swayScale = adsK > 0.5 ? 0.05 : 1;
    const apy = -(m.sightY !== undefined ? m.sightY : (m.adsPos ? m.adsPos[1] : 0.10));
    const py = THREE.MathUtils.lerp(m.basePos.y, apy, adsK) + this.sway.y * swayScale * (1 - adsK) + by * (1 - adsK) - this.lower * 0.26 * (1 - adsK) - this.kick * 0.03 * (1 - adsK);
    const px = THREE.MathUtils.lerp(m.basePos.x, apx, adsK) + this.sway.x * swayScale * (1 - adsK) + bx * (1 - adsK);
    const pz = THREE.MathUtils.lerp(m.basePos.z, apz, adsK) + this.kick * 0.07 * (1 - adsK);
    m.holder.position.set(px, py, pz);
    // At full ADS the gun must be straight: no sway/bob/kick rotation, so the
    // sight stays exactly on the crosshair instead of drifting off-centre.
    const rotK = 1 - adsK;
    m.holder.rotation.set(
      -this.kickRot * 0.25 * rotK + this.sway.y * 0.8 * rotK - this.lower * 0.5 * rotK,
      m.baseRot.y + this.sway.x * 0.9 * rotK + 0.02 * rotK + this.sprintWeight * 0.53 * rotK,
      m.baseRot.z + this.sway.x * 0.5 * rotK + this.sprintWeight * 0.2 * rotK
    );

    // reload animation: mag dip + tilt + return
    if (reloading && this.reloadT > 0) {
      const k = THREE.MathUtils.clamp(this.reloadT / d.reload, 0, 1);
      const phase = k < 0.22 ? k / 0.22 : k < 0.7 ? 1 : (1 - k) / 0.3;
      const dip = phase * phase * (3 - 2 * phase);
      m.holder.position.y -= dip * 0.10;
      m.holder.rotation.x += dip * 0.42;
      m.holder.rotation.z += dip * 0.30;
      m.holder.position.z += dip * 0.03;
    }

    // root is parented to the camera, which three updates at render time: force only the
    // gun's own transform (a deep updateMatrixWorld here also re-dirties the camera scale
    // and the whole world along with it, every single step)
    this.root.updateMatrixWorld();
  }
}

/* ---------------------------------------------------------------------
   GunSystem — ammo, fire modes, spread bloom, reloads, ADS, switching.
   The actual raycast is delegated to the game via onFire(config, spread).
   --------------------------------------------------------------------- */
export class GunSystem {
  constructor(audio) {
    this.audio = audio;
    this.loadout = { primary: 'm4', secondary: 'p226' };
    this.slot = 0;
    this.state = { m4: null, ak: null, mp7: null, super90: null, awm: null, p226: null, deagle: null };
    this.cur = null; this.def = null;
    this.cooldown = 0; this.reloading = false; this.reloadT = 0;
    this.spreadBloom = 0; this.adsWant = 0;
    this.lastShot = 0; this.burstLeft = 0;
    this.onFire = null; this.onReloadDone = null; this.onStateChange = null;
  }
  reset() {
    for (const id in WEAPONS) {
      const d = WEAPONS[id];
      this.state[id] = { mag: d.mag, reserve: d.reserve };
    }
    this.slot = 0; this.reloading = false; this.reloadT = 0;
    this.cur = null; this.def = null; this.cooldown = 0; this.now = 0; this.lastShot = 0;
    this.adsWant = 0; this.spreadBloom = 0;
    this.equipSlot(0, true);
  }
  get primaryId() { return this.loadout.primary; }
  idsForSlot(s) { return s === 0 ? this.loadout.primary : this.loadout.secondary; }
  equipSlot(s, instant = false) {
    if (s === this.slot && this.def?.id === this.idsForSlot(s) && this.cur === this.state[this.idsForSlot(s)]) return;
    this.slot = s;
    const id = this.idsForSlot(s);
    this.cur = this.state[id]; this.def = WEAPONS[id];
    this.reloading = false; this.reloadT = 0;
    this.cooldown = instant ? 0 : Math.max(this.cooldown, (this.now || 0) + 0.28);
    this.spreadBloom = 0;
    this.onStateChange && this.onStateChange(id, this.cur);
  }
  toggleSlot() { this.equipSlot(this.slot === 0 ? 1 : 0); }
  get ammo() { return this.cur; }
  startReload() {
    if (!this.cur || this.reloading) return;
    if (this.cur.mag >= this.def.mag || this.cur.reserve <= 0) return;
    this.reloading = true; this.reloadT = 0;
    this.audio && this.audio.reload(false);
    this.reloadSoundPlayed = false;
  }
  setAdsWant(v) { this.adsWant = v; }
  /** returns true if a shot was fired */
  tryFire(now, downThisFrame) {
    if (!this.cur || this.reloading || now < this.cooldown) return false;
    const d = this.def;
    if (!d.auto && !downThisFrame) return false;
    if (this.cur.mag <= 0) {
      if (downThisFrame) { this.audio && this.audio.dryFire(); this.cooldown = now + 0.22; this.startReload(); }
      return false;
    }
    this.cur.mag--;
    this.lastShot = now;
    this.cooldown = now + 60 / d.rpm;
    // spread: base + bloom + movement
    const ads = this.adsWant > 0.5;
    const spread = (ads ? d.adsSpread : d.spread) + this.spreadBloom * (ads ? 0.3 : 1);
    this.spreadBloom = Math.min(0.05, this.spreadBloom + (d.pellets ? 0.012 : 0.0022));
    this.onFire && this.onFire(d, spread, ads);
    this.onStateChange && this.onStateChange(d.id, this.cur);
    return true;
  }
  update(dt, now) {
    this.now = now;
    this.spreadBloom = Math.max(0, this.spreadBloom - dt * (this.spreadBloom > 0.02 ? 0.075 : 0.05));
    if (this.reloading) {
      this.reloadT += dt;
      if (!this.reloadSoundPlayed && this.reloadT >= Math.min(0.5, this.def.reload * 0.4)) {
        this.reloadSoundPlayed = true;
        this.audio && this.audio.reload(true);
      }
      if (this.reloadT >= this.def.reload) {
        const need = this.def.mag - this.cur.mag;
        const take = Math.min(need, this.cur.reserve);
        this.cur.mag += take; this.cur.reserve -= take;
        this.reloading = false; this.reloadT = 0;
        this.onReloadDone && this.onReloadDone(this.def.id, this.cur);
        this.onStateChange && this.onStateChange(this.def.id, this.cur);
      }
    }
  }
  addAmmo(frac = 0.5) {
    for (const id in this.state) {
      const s = this.state[id], d = WEAPONS[id];
      s.reserve = Math.min(d.reserve, s.reserve + Math.ceil(d.reserve * frac));
    }
  }
}
