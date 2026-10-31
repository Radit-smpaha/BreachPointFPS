// BREACHPOINT — level loader. Uses the same loadMap() pipeline that was tuned
// for these Blender exports (atmosphere presets, static batching, sky dome,
// particles, light pool) and additionally derives gameplay data from the mesh:
// collision boxes, a navigation grid, cover spots, objective nodes and spawns.
import * as THREE from 'three';
import { Colliders, NavGrid } from './world.js';
import { loadMap, PRESETS } from './loadMap.js';
import { rayBox } from './world.js';

export const MAPS = {
  factory: {
    id: 'factory', name: 'ABANDONED STEELWORKS', sub: 'Night breach · Industrial district',
    file: 'abandoned_factory.glb', title: 'STEELWORKS', code: 'TH-01',
    desc: 'Rusting production halls, catwalks and conveyor cover.',
    tags: ['INDUSTRIAL', 'CLOSE-RANGE', '3 FLOORS'], hostiles: 9,
    accent: '#ffb020', menuCamera: { pos: [0, 6, 46], look: [0, 2, 0] },
  },
  snow: {
    id: 'snow', name: 'SNOWY LODGE', sub: 'Blue hour · Alpine outpost',
    file: 'snowy_lodge.glb', title: 'LODGE', code: 'TH-02',
    desc: 'Timber lodge, deep snow, heavy cold fog and long sightlines.',
    tags: ['ALPINE', 'LONG RANGE', 'SNOW'], hostiles: 9,
    accent: '#9fd0ff', menuCamera: { pos: [0, 7, 52], look: [0, 2, 0] },
  },
  desert: {
    id: 'desert', name: 'DESERT TOWN', sub: 'Golden hour · Dust district',
    file: 'desert_town.glb', title: 'DUST TOWN', code: 'TH-03',
    desc: 'Sun-bleached streets, rooftops and narrow alley flanks.',
    tags: ['URBAN', 'VERTICAL', 'DUST'], hostiles: 9,
    accent: '#ff9a5c', menuCamera: { pos: [0, 8, 56], look: [0, 2, 0] },
  },
};

const _losDir = new THREE.Vector3(), _losO = new THREE.Vector3();

export class Level {
  constructor(scene, renderer, camera) {
    this.scene = scene; this.renderer = renderer; this.camera = camera;
    this.map = null; this.colliders = null; this.nav = null;
    this.spawns = []; this.bounds = null;
  }
  async load(id, { shadows = true, particles = true, onProgress } = {}) {
    this.unload();
    const def = MAPS[id];
    const map = await loadMap(id, this.scene, this.renderer, this.camera, {
      shadows, shadowSize: 2048, particles, mergeStatic: false, lightPool: 6,
      basePath: './assets/maps/',
    });
    this.map = map; this.def = def;
    const root = map.root;
    // the atmosphere preset the loader applied (exposure + fog), so the game can respect it
    this.presentation = PRESETS[id] || { exposure: 1, fog: [0x101010, 0.01] };

    // ---------- colliders from the merged static geometry
    const colliders = new Colliders();
    let meshCount = 0;
    root.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      // ignore tiny decorative bits (glow / particles)
      if (o.material && /glow/i.test(o.material.name || '')) return;
      const bs = o.geometry.boundingSphere || o.geometry.computeBoundingSphere();
      // Lodge/dust_town floors are separate tile meshes; each tile's bounding
      // sphere is ~0.15-0.25 m, so a 0.25 cut skipped them wholesale — that is the
      // "specific spots" where you fall through. Only skip true micro-details.
      if (bs && bs.radius < 0.12) return;
      colliders.addFromMesh(o);
      meshCount++;
    });
    // spawn markers are data, not architecture: they must never become a collider
    // that swallows the player (they sit on every valid spawn point)
    const SP = map.spawns || [];
    colliders.boxes = colliders.boxes.filter(b => {
      if (b.maxY - b.minY > 1.4 || b.maxX - b.minX > 1.4 || b.maxZ - b.minZ > 1.4) return true;
      return !SP.some(s => b.minX <= s.position.x + 0.2 && b.maxX >= s.position.x - 0.2 && b.minZ <= s.position.z + 0.2 && b.maxZ >= s.position.z - 0.2);
    });
    // dedupe colliders (quads produce identical pairs; instancing duplicates)
    const uniq = [];
    const seen = new Set();
    for (const b of colliders.boxes) {
      const k = b.minX.toFixed(2) + ',' + b.minY.toFixed(2) + ',' + b.minZ.toFixed(2) + ',' + b.maxX.toFixed(2) + ',' + b.maxY.toFixed(2) + ',' + b.maxZ.toFixed(2);
      if (seen.has(k)) continue;
      seen.add(k); uniq.push(b);
    }
    colliders.boxes = uniq;
    colliders.build();
    this.colliders = colliders;

    // ---------- bounds
    let bounds = map.bounds;
    const box = new THREE.Box3().setFromObject(root);
    if (!bounds || !isFinite(bounds.minX)) {
      bounds = { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z };
    } else {
      // glTF extras bounds sometimes are [min, max] arrays
      if (Array.isArray(bounds)) { const a = bounds[0], b = bounds[1] || bounds[0]; bounds = { minX: a[0], minZ: a[2], maxX: b[0], maxZ: b[2] }; }
    }
    // shrink slightly to stay inside walls
    bounds = { minX: bounds.minX + 1.2, maxX: bounds.maxX - 1.2, minZ: bounds.minZ + 1.2, maxZ: bounds.maxZ - 1.2 };
    this.bounds = bounds;
    this.worldBox = box;

    onProgress && onProgress('MAPPING NAVIGATION…');
    this.nav = new NavGrid(colliders, bounds, { cell: 1.15, agentRadius: 0.4 });
    // Flatten nav *floor* pass: a cell whose floor differs from the HIGHEST of its
    // walkable neighbours by more than a step is either a pit (gap in the mesh) or the
    // underside of a slab — a heightfield cannot represent either, so clamp it.
    {
      const n = this.nav, w = n.w, h = n.h, fixes = [];
      for (let iz = 1; iz < h - 1; iz++) for (let ix = 1; ix < w - 1; ix++) {
        const i = iz * w + ix;
        if (!n.walk[i]) continue;
        let hi = -Infinity, lo = Infinity;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = n.index(ix + dx, iz + dz);
          if (j < 0 || !n.walk[j]) continue;
          hi = Math.max(hi, n.floor[j]); lo = Math.min(lo, n.floor[j]);
        }
        if (!isFinite(hi)) continue;
        if (n.floor[i] > hi + 0.75) fixes.push([i, hi]);          // floating on a slab
        else if (n.floor[i] < lo - 0.75) fixes.push([i, lo]);     // sunk in a pit
        // isolated shelf/roof (no walkable neighbour within a step): not a walkable level
        else if (n.floor[i] > hi + 0.45) fixes.push([i, -1]);
      }
      for (const [i, y] of fixes) n.floor[i] = y;
    }

    // ---------- spawns: the player MUST start on the navmesh. Marker empties are
    // unreliable (no geometry under them, or offset from the floor), so we snap every
    // marker to the nearest walkable cell and pick the most open one — that is what
    // makes the first step, the first sightline and the first path all valid.
    const raw = (map.spawns || []).filter(s => isFinite(s.position.y));
    const cands = [];
    for (const s of raw) {
      const i = this.nav.nearestWalkable(s.position.x, s.position.z, 12);
      if (i >= 0) cands.push({ s, i });
    }
    if (!cands.length) {
      const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
      const i = this.nav.nearestWalkable(cx, cz, 60);
      if (i >= 0) cands.push({ s: { position: new THREE.Vector3(), yaw: 0 }, i });
    }
    // Choose the deploy cell: the walkable CELL nearest each marker (the raw cell under
    // a decorative empty is often not walkable at all, and `floor` there holds a
    // meaningless 0 — which is exactly how the operator ended up underground).
    for (const c of cands) c.w = this.nav.cellToWorld(c.i);
    let pick = cands[0] || null;
    if (cands.length > 1) {
      let bestScore = -1e9;
      for (const c of cands) {
        const [ix, iz] = this.nav.worldToCell(c.w.x, c.w.z);
        const y = this.nav.floor[c.i];
        let open = 0;
        for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
          const j = this.nav.index(ix + dx, iz + dz);
          if (j >= 0 && this.nav.walk[j] && Math.abs(this.nav.floor[j] - y) < 0.7) open++;
        }
        // open floor wins; a marker stranded on a bridge/roof loses against a courtyard.
        // The height term stays small: marker y comes from arbitrary empties.
        const score = open * 10 - Math.min(8, Math.abs(y - c.s.position.y));
        if (score > bestScore) { bestScore = score; pick = c; }
      }
    }
    // Level-correct marker snapping: use the marker's own y as the search ceiling so a
    // spawn on an upper floor never gets rewritten to the ground beneath it.
    const snap = (s) => {
      const i = this.nav.nearestWalkable(s.position.x, s.position.z, 14);
      if (i < 0) { s.position.y = colliders.groundHeight(s.position.x, s.position.z, s.position.y + 0.5, 1.5); return; }
      const w = this.nav.cellToWorld(i);
      // ceiling = marker + 1.2: pick the floor at/just under the marker when possible
      const top = colliders.groundHeight(w.x, w.z, s.position.y + 1.2, 1.6);
      s.position.set(w.x, isFinite(top) ? top : this.nav.floor[i], w.z);
      s.navY = this.nav.floor[i];
    };
    raw.forEach(snap);
    if (pick) snap(pick.s);
    this.spawns = raw.length ? raw : [pick ? pick.s : { position: new THREE.Vector3(), yaw: 0 }];
    this.playerSpawn = pick ? pick.s : this.spawns[0];
    // The nav layer is the authority for height (it is built from the meshes, not from
    // functionally-placed markers), so the deploy point sits exactly on it.
    if (pick) {
      const w = this.nav.cellToWorld(pick.i);
      this.playerSpawn.position.set(w.x, this.nav.floor[pick.i], w.z);
      console.info('[bp] deploy pick#' + pick.i + ' navY=' + this.nav.floor[pick.i].toFixed(2) + ' at ' + w.x.toFixed(1) + ',' + w.z.toFixed(1));
    } else console.info('[bp] deploy pick=none');

    this._typicalFloor = (() => {
      const n = this.nav; let best = 0, bestOpen = -1;
      for (let i = 0; i < n.walk.length; i += 7) {
        if (!n.walk[i]) continue;
        const w = n.cellToWorld(i); const [ix, iz] = n.worldToCell(w.x, w.z);
        let open = 0;
        for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) { const j = n.index(ix + dx, iz + dz); if (j >= 0 && n.walk[j] && Math.abs(n.floor[j] - n.floor[i]) < 0.7) open++; }
        const y = n.floor[i];
        if (open > bestOpen) { bestOpen = open; best = y; }
      }
      return best;
    })();
    // final word: never deploy with the eyes inside geometry. If the chosen spot is
    // unusually low compared to the map, verify a surface exists right under it and
    // otherwise fall back to the most populated walkable cell beside it.
    if (this.playerSpawn) {
      const p = this.playerSpawn.position;
      const under = colliders.groundHeight(p.x, p.z, p.y + 0.6, 1.2);
      if (!isFinite(under) || Math.abs(under - p.y) > 1.0) {
        let best = -1, bestOpen = -1;
        for (let i = 0; i < this.nav.walk.length; i++) {
          if (!this.nav.walk[i]) continue;
          const w = this.nav.cellToWorld(i);
          const d = Math.hypot(w.x - p.x, w.z - p.z);
          if (d > 30) continue;
          // same layer as the chosen marker (±2.5 m): the rescue must not drop the
          // operator into a basement just because that cell is more open
          if (Math.abs(this.nav.floor[i] - p.y) > 2.5) continue;
          const [ix, iz] = this.nav.worldToCell(w.x, w.z);
          let open = 0;
          for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { const j = this.nav.index(ix + dx, iz + dz); if (j >= 0 && this.nav.walk[j]) open++; }
          // a spot level with the map's main floor is worth real distance
          const typ = this._typicalFloor || 0;
          const score = open - d * 0.15 - Math.abs(this.nav.floor[i] - typ) * 2;
          if (score > bestOpen) { bestOpen = score; best = i; }
        }
        if (best >= 0) { const w = this.nav.cellToWorld(best); p.set(w.x, this.nav.floor[best], w.z); }

      }
    }

    // ---------- objectives: two relay nodes placed far apart in walkable space
    this.objectives = this.pickObjectives();
    this.enemySpawns = this.pickEnemySpawns();
    return this;
  }

  pickObjectives() {
    const nav = this.nav;
    const sp = this.playerSpawn ? this.playerSpawn.position : { x: 0, z: 0 };
    const cells = [];
    for (let i = 0; i < nav.walk.length; i++) {
      if (!nav.walk[i]) continue;
      const w = nav.cellToWorld(i);
      if (Math.hypot(w.x - sp.x, w.z - sp.z) < 8) continue;   // never arm a relay on top of the spawn
      cells.push(i);
    }
    const farCells = cells.filter(i => { const w = nav.cellToWorld(i); return Math.hypot(w.x - sp.x, w.z - sp.z) > 22; });
    const pool = farCells.length ? farCells : cells;
    const a = pool[(Math.random() * pool.length) | 0];
    const wa = nav.cellToWorld(a);
    const poolB = pool.filter(i => { const w = nav.cellToWorld(i); return Math.hypot(w.x - wa.x, w.z - wa.z) > 26; });
    const b = (poolB.length ? poolB : pool)[(Math.random() * (poolB.length || pool.length)) | 0];
    const out = [];
    const names = ['RELAY ALPHA', 'RELAY BRAVO'];
    [a, b].forEach((cell, k) => {
      if (cell == null) return;
      const w = nav.cellToWorld(cell);
      const y = nav.floor[cell];
      out.push({ id: k, name: names[k], pos: new THREE.Vector3(w.x, y, w.z), progress: 0, armed: false });
    });
    return out;
  }

  pickEnemySpawns() {
    const nav = this.nav;
    const sp = this.playerSpawn ? this.playerSpawn.position : { x: 0, z: 0 };
    const cells = [];
    for (let i = 0; i < nav.walk.length; i++) if (nav.walk[i]) {
      const w = nav.cellToWorld(i);
      const d = Math.hypot(w.x - sp.x, w.z - sp.z);
      // >= 15 m: far enough to be a fight, close enough that the fog does not hide them
      if (d > 15) cells.push(i);
    }
    // REMOVED: never spawn on mountain/edge cells (steep ground that looks like a mountain).
    // A walkable cell is flat if its own floor matches the floor of its 8 neighbors within 0.6 m.
    const flat = cells.filter(i => {
      const y = nav.floor[i];
      if (!isFinite(y)) return false;
      const [ix, iz] = [i % nav.w, (i - i % nav.w) / nav.w];
      let flatOk = true;
      for (let dz = -1; dz <= 1 && flatOk; dz++) for (let dx = -1; dx <= 1 && flatOk; dx++) {
        const j = nav.index(ix + dx, iz + dz);
        if (j >= 0 && nav.walk[j] && Math.abs(nav.floor[j] - y) > 0.7) flatOk = false;
      }
      return flatOk;
    });
    return flat.length ? flat : cells;
  }

  /** exact LOS between two points using the collider ray test */
  losBlocked(a, b) { // alloc-free
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return false;
    // scratch vectors: the AI litmus-tests LOS dozens of times per think tick
    const d = _losDir.set(dx / len, dy / len, dz / len);
    // start 12 cm in: the sample point itself may sit inside the wall the test point leans on
    const o = _losO.set(a.x + d.x * 0.12, a.y + d.y * 0.12, a.z + d.z * 0.12);
    const hit = this.colliders.raycastBoxes(o, d, len - 0.18);
    return !!hit && hit.t > 0.05;
  }
  losBlockedSampled(a, b) {
    // broad-phase: sample along the segment, only test nearby boxes
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return false;
    const steps = Math.max(2, Math.min(28, Math.ceil(len / 2.2)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      const list = this.colliders.query(x - 0.4, z - 0.4, x + 0.4, z + 0.4);
      for (const bx of list) {
        if (x > bx.minX && x < bx.maxX && z > bx.minZ && z < bx.maxZ && y > bx.minY && y < bx.maxY) return true;
      }
    }
    return false;
  }

  /** full ray vs colliders + heightfield; returns nearest { point, normal, t } */
  raycast(origin, dir, maxDist) {
    // straight up/down rays march a single grid column: the horizontal DDA cannot
    // bound that loop, so those axes are tested directly against that column
    const strongY = Math.abs(dir.y) > Math.abs(dir.x) + Math.abs(dir.z) * 0.999 && Math.abs(dir.y) > 0.99;
    const hit = strongY ? this._columnRay(origin, dir, maxDist) : this.colliders.raycastBoxes(origin, dir, maxDist);
    if (!hit) return null;
    // accept plain {x,y,z} points (AI passes scratch vectors, tests pass literals)
    const point = new THREE.Vector3(
      origin.x + dir.x * hit.t, origin.y + dir.y * hit.t, origin.z + dir.z * hit.t
    );
    const b = hit.box;
    // pick the normal from the face we are closest to
    const normal = new THREE.Vector3();
    if (Math.abs(point.x - b.minX) < 0.06) normal.set(-1, 0, 0);
    else if (Math.abs(point.x - b.maxX) < 0.06) normal.set(1, 0, 0);
    else if (Math.abs(point.y - b.minY) < 0.06) normal.set(0, -1, 0);
    else if (Math.abs(point.y - b.maxY) < 0.06) normal.set(0, 1, 0);
    else if (Math.abs(point.z - b.minZ) < 0.06) normal.set(0, 0, -1);
    else normal.set(0, 0, 1);
    return { point, normal, t: hit.t, box: b };
  }

  /** vertical ray against the collider column under the origin (no horizontal march) */
  _columnRay(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    for (const b of this.colliders.query(origin.x - 0.02, origin.z - 0.02, origin.x + 0.02, origin.z + 0.02)) {
      const t = rayBox(origin, dir, b, bestT);
      if (t !== null && t >= 0 && t < bestT) { bestT = t; best = b; }
    }
    return best ? { t: bestT, box: best } : null;
  }

  update(dt, focus = null) {
    if (this.map) this.map.update(dt, this.camera, focus);
  }

  /** runtime respawn point: the most open floor near `avoid`, biased away from danger */
  chooseSpawn(nav, avoid, awayFrom = null) {
    const start = nav.nearestWalkable(avoid.x, avoid.z, 16);
    const want = start >= 0 ? start : nav.nearestWalkable(0, 0, 60);
    let best = null, bestScore = -1e9;
    for (let i = 0; i < nav.walk.length; i++) {
      if (!nav.walk[i]) continue;
      const w = nav.cellToWorld(i);
      const d = Math.hypot(w.x - avoid.x, w.z - avoid.z);
      if (d < 5 || d > 45 || Math.abs(nav.floor[i] - avoid.y) > 2) continue;
      let t = 0;
      if (awayFrom) t = Math.hypot(w.x - awayFrom.x, w.z - awayFrom.z);
      // a bit of jitter so repeat deaths don't land in the same doorway
      const score = t * 0.5 + Math.sin(i * 12.9898) * 2 - (d - 10) * 0.05;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best == null) best = want;
    return best >= 0 ? { position: new THREE.Vector3(nav.cellToWorld(best).x, nav.floor[best], nav.cellToWorld(best).z), yaw: 0 } : null;
  }

  unload() {
    if (this.map) { this.map.dispose(); this.map = null; }
  }
}

