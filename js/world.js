// BREACHPOINT — world: map colliders (AABB), navigation grid, raycasts, player physics
import * as THREE from 'three';

export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
/** temp vectors so per-frame math never allocates */
export const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _wish = new THREE.Vector3(), _stepProbe = new THREE.Vector3();
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));

/* =====================================================================
   COLLIDERS — every static map triangle gets an axis-aligned box.
   Triangles from these Blender maps are axis-aligned boxes, so the tight
   bounds are exact. Only "large" triangles become colliders: tiny detail
   (rubble, wires, railings) would otherwise snag the player.
   ===================================================================== */
export class Colliders {
  constructor() { this.boxes = []; this.grid = new Map(); this.cell = 4; }
  addFromMesh(mesh, { minSize = 0.45 } = {}) {
    const g = mesh.geometry;
    if (!g || !g.attributes.position) return;
    const pos = g.attributes.position, idx = g.index;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    const m = mesh.matrixWorld;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < triCount; t++) {
      let i0, i1, i2;
      if (idx) { i0 = idx.getX(t * 3); i1 = idx.getX(t * 3 + 1); i2 = idx.getX(t * 3 + 2); }
      else { i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2; }
      a.fromBufferAttribute(pos, i0).applyMatrix4(m);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m);
      const minX = Math.min(a.x, b.x, c.x), maxX = Math.max(a.x, b.x, c.x);
      const minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
      const minZ = Math.min(a.z, b.z, c.z), maxZ = Math.max(a.z, b.z, c.z);
      const sx = maxX - minX, sy = maxY - minY, sz = maxZ - minZ;
      // a non-degenerate horizontal quad is 2 large flat tris: add it as a floor/ceiling slab
      const flat = sy < 0.12;
      const wallish = sy > 0.35;
      if (!flat && !wallish) continue;
      // flat quads ARE floors — Lodge/dust_town use tiled floor geometry where each
      // tile is well under 0.9 m, so filtering them out punches holes in the collision
      // floor and you phase straight through. Keep any flat quad >= minSize instead.
      // flat quads ARE floors — Lodge/dust_town use tiled floor geometry where
      // individual planks/tiles are only 0.2-0.4 m, so anything above that punches
      // holes in the collision floor you fall through. Keep flat quads >= 0.2 m.
      if (flat && (sx < 0.2 || sz < 0.2)) continue;
      if (wallish && Math.max(sx, sz) < 0.28) continue;
      const box = { minX, minY, maxX, maxY, minZ, maxZ };
      // merge duplicate coplanar copies (every quad yields 2 tris)
      this.boxes.push(box);
    }
    this.build();
  }
  build() {
    this.grid.clear();
    this._stamp = new Uint32Array(this.boxes.length);
    this._rastamp = new Uint32Array(this.boxes.length);
    this._qstamp = 0; this._rstamp = 0;
    const C = this.cell;
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const x0 = Math.floor(b.minX / C), x1 = Math.floor(b.maxX / C);
      const z0 = Math.floor(b.minZ / C), z1 = Math.floor(b.maxZ / C);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4000) continue; // absurdly large: skip spatial index (rare)
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = x + ',' + z;
        let arr = this.grid.get(k); if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(i);
      }
    }
  }
  /** fills an internal scratch array with every box in the queried cells (alloc-free) */
  query(minX, minZ, maxX, maxZ) {
    const C = this.cell, out = this._buf || (this._buf = []);
    out.length = 0;
    this._qstamp = (this._qstamp || 0) + 1;
    const stamp = this._stamp || (this._stamp = new Int32Array(this.boxes.length));
    const x0 = Math.floor(minX / C), x1 = Math.floor(maxX / C);
    const z0 = Math.floor(minZ / C), z1 = Math.floor(maxZ / C);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const arr = this.grid.get(x + ',' + z);
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) { const i = arr[k]; if (stamp[i] !== this._qstamp) { stamp[i] = this._qstamp; out.push(this.boxes[i]); } }
    }
    return out;
  }
  /** circle vs AABB horizontal sweep — pushes `pos` (x,z) out of boxes overlapping [y, y+height] */
  resolveCircle(pos, radius, feetY, height) {
    const y0 = feetY + 0.05, y1 = feetY + height;
    let iter = 0, hit = false;
    do {
      hit = false;
      const list = this.query(pos.x - radius - 0.1, pos.z - radius - 0.1, pos.x + radius + 0.1, pos.z + radius + 0.1);
      for (const b of list) {
        if (b.maxY < y0 || b.minY > y1) continue;
        // closest point on box to circle centre
        const cx = clamp(pos.x, b.minX, b.maxX), cz = clamp(pos.z, b.minZ, b.maxZ);
        let dx = pos.x - cx, dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= radius * radius) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2), push = radius - d;
          pos.x += (dx / d) * push; pos.z += (dz / d) * push;
        } else {
          // centre inside box: push out along smallest axis
          const l = pos.x - b.minX, r = b.maxX - pos.x, bk = pos.z - b.minZ, f = b.maxZ - pos.z;
          const m = Math.min(l, r, bk, f);
          if (m === l) pos.x = b.minX - radius; else if (m === r) pos.x = b.maxX + radius;
          else if (m === bk) pos.z = b.minZ - radius; else pos.z = b.maxZ + radius;
        }
        hit = true;
      }
      iter++;
    } while (hit && iter < 4);
  }
  /**
   * Highest floor/walkable top under a position within `stepUp` of the feet.
   * `radius` samples a small footprint instead of a single point: on lodge and
   * dust_town the floor is built from many small quads, so a point sample could
   * fall between two of them (a seam/gap) and report "no floor" — the player
   * then fell straight through the map.
   */
  groundHeight(x, z, feetY, stepUp = 0.55, radius = 0) {
    let best = -Infinity;
    const list = this.query(x - radius - 0.01, z - radius - 0.01, x + radius + 0.01, z + radius + 0.01);
    const r2 = radius * radius;
    for (const b of list) {
      if (b.maxY > feetY + stepUp + 0.001 || b.maxY <= best) continue;
      if (this._inFootprint(b, x, z, radius, r2)) best = b.maxY;
    }
    return best;
  }
  /** square test (cheap) or, with a radius, a square+circle union so edges still count */
  _inFootprint(b, x, z, radius, r2) {
    if (!radius) return x >= b.minX - 0.02 && x <= b.maxX + 0.02 && z >= b.minZ - 0.02 && z <= b.maxZ + 0.02;
    if (x >= b.minX - 0.02 && x <= b.maxX + 0.02 && z >= b.minZ - 0.02 && z <= b.maxZ + 0.02) return true;
    const cx = clamp(x, b.minX, b.maxX), cz = clamp(z, b.minZ, b.maxZ);
    const dx = x - cx, dz = z - cz;
    return dx * dx + dz * dz <= r2;
  }
  /** true if a box's top is at head-height (low cover) */
  raycastBoxes(origin, dir, maxDist) {
    let best = null, bestT = maxDist;
    this._rstamp = (this._rstamp || 0) + 1;
    const stamp = this._rastamp || (this._rastamp = new Int32Array(this.boxes.length));
    const stampId = this._rstamp;
    // broad phase: one 2D DDA march through the box grid (no fat AABB queries)
    const C = this.cell, B = this.boxes;
    let ix = Math.floor(origin.x / C), iz = Math.floor(origin.z / C);
    const stepX = dir.x > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const invX = Math.abs(dir.x) > 1e-8 ? 1 / Math.abs(dir.x) : Infinity;
    const invZ = Math.abs(dir.z) > 1e-8 ? 1 / Math.abs(dir.z) : Infinity;
    let tMaxX = invX === Infinity ? Infinity : ((dir.x > 0 ? (ix + 1) * C - origin.x : origin.x - ix * C) * invX);
    let tMaxZ = invZ === Infinity ? Infinity : ((dir.z > 0 ? (iz + 1) * C - origin.z : origin.z - iz * C) * invZ);
    let t = 0, guard = 0;
    while (t <= bestT && guard++ < 512) {
      const arr = this.grid.get(ix + ',' + iz);
      if (arr) for (let k = 0; k < arr.length; k++) {
        const i = arr[k];
        if (stamp[i] === stampId) continue;
        stamp[i] = stampId;
        const bt = rayBox(origin, dir, B[i], bestT);
        if (bt !== null && bt < bestT) { bestT = bt; best = B[i]; }
      }
      if (tMaxX < tMaxZ) { if (tMaxX > bestT) break; t = tMaxX; tMaxX += C * invX; ix += stepX; }
      else { if (tMaxZ > bestT) break; t = tMaxZ; tMaxZ += C * invZ; iz += stepZ; }
    }
    return best ? { t: bestT, box: best } : null;
  }
}

export function rayBox(o, d, b, maxT) {
  let tmin = 0, tmax = maxT;
  for (let i = 0; i < 3; i++) {
    const origin = i === 0 ? o.x : i === 1 ? o.y : o.z;
    const direction = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const min = i === 0 ? b.minX : i === 1 ? b.minY : b.minZ;
    const max = i === 0 ? b.maxX : i === 1 ? b.maxY : b.maxZ;
    if (Math.abs(direction) < 1e-8) { if (origin < min || origin > max) return null; }
    else {
      let t1 = (min - origin) / direction, t2 = (max - origin) / direction;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

// segment vs box (for LOS through tall walls) — same slab test
export function segmentBlocked(a, b, box) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const len = Math.hypot(d.x, d.y, d.z);
  if (len < 1e-5) return false;
  const nd = { x: d.x / len, y: d.y / len, z: d.z / len };
  const t = rayBox(a, nd, box, len);
  return t !== null && t > 0.02 && t < len - 0.05;
}

/* =====================================================================
   NAVIGATION GRID — derived from collider footprints. A column is walkable
   if the player capsule fits and the step to neighbours is small.
   ===================================================================== */
export class NavGrid {
  constructor(colliders, bounds, { cell = 1.1, agentRadius = 0.42, maxSlope = 0.6 } = {}) {
    this.c = colliders; this.cell = cell; this.r = agentRadius;
    const W = bounds.maxX - bounds.minX, D = bounds.maxZ - bounds.minZ;
    this.x0 = bounds.minX; this.z0 = bounds.minZ;
    this.w = Math.ceil(W / cell); this.h = Math.ceil(D / cell);
    const N = this.w * this.h;
    this.walk = new Uint8Array(N); this.floor = new Float32Array(N).fill(NaN); this.cover = new Uint8Array(N);
    const solid = new Uint8Array(N);
    // --- sample the heightfield. One sample per cell is not enough on stairs, ramps or
    // the storey-boundary of a multi-floor map: a single cell can legitimately hold an
    // upper floor AND the ground beside a slab, and the capsule test has to run at the
    // ACTUAL height the body would stand at. Sample centres + four offsets, keep the
    // highest surface free of headroom collisions.
    for (let iz = 0; iz < this.h; iz++) for (let ix = 0; ix < this.w; ix++) {
      const i = iz * this.w + ix;
      const x = this.x0 + (ix + 0.5) * cell, z = this.z0 + (iz + 0.5) * cell;
      const off = cell * 0.3;
      let gh = -Infinity;
      for (let s = 0; s < 5; s++) {
        const sx = s === 0 ? x : x + (s === 1 ? off : s === 2 ? -off : 0);
        const sz = s === 0 ? z : z + (s === 3 ? off : s === 4 ? -off : 0);
        const h = colliders.groundHeight(sx, sz, 2.0, 2.0);
        if (!isFinite(h)) continue;
        // a surface blocks the capsule if anything occupies the body space above it
        const list = colliders.query(sx - this.r, sz - this.r, sx + this.r, sz + this.r);
        let free = true;
        for (const b of list) {
          if (b.maxY < h + 0.8 || b.minY > h + 1.8) continue;
          if (sx + this.r > b.minX + 0.02 && sx - this.r < b.maxX - 0.02 && sz + this.r > b.minZ + 0.02 && sz - this.r < b.maxZ - 0.02) { free = false; break; }
        }
        if (free && h > gh) gh = h;
      }
      if (!isFinite(gh)) { solid[i] = 1; this.floor[i] = 0; continue; }
      this.floor[i] = gh;
      // final capsule test at the chosen height, on the cell footprint itself
      const list = colliders.query(x - this.r, z - this.r, x + this.r, z + this.r);
      let ok = true;
      for (const b of list) {
        if (b.maxY < gh + 0.5 || b.minY > gh + 1.75) continue;
        if (x + this.r > b.minX + 0.02 && x - this.r < b.maxX - 0.02 && z + this.r > b.minZ + 0.02 && z - this.r < b.maxZ - 0.02) { ok = false; break; }
      }
      this.walk[i] = ok ? 1 : 0;
    }
    // mark low cover cells (a box near the cell whose top is 0.6..1.6m above the floor)
    for (let i = 0; i < N; i++) {
      if (!this.walk[i]) continue;
      const { x, z } = this.cellToWorld(i);
      const f = this.floor[i];
      const list = colliders.query(x - cell, z - cell, x + cell, z + cell);
      for (const b of list) {
        if (b.maxY > f + 0.55 && b.maxY < f + 1.65 && b.minY < f + 0.3) {
          const cx = clamp(x, b.minX, b.maxX), cz = clamp(z, b.minZ, b.maxZ);
          if (Math.hypot(x - cx, z - cz) < cell * 1.2) { this.cover[i] = 1; break; }
        }
      }
    }
    // remove isolated cells
    for (let iz = 1; iz < this.h - 1; iz++) for (let ix = 1; ix < this.w - 1; ix++) {
      const i = iz * this.w + ix;
      if (!this.walk[i]) continue;
      let n = 0;
      for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (this.walk[(iz + d[1]) * this.w + (ix + d[0])]) n++;
      if (n === 0) this.walk[i] = 0;
    }
  }

  index(ix, iz) { return ix < 0 || iz < 0 || ix >= this.w || iz >= this.h ? -1 : iz * this.w + ix; }
  worldToCell(x, z) { return [Math.floor((x - this.x0) / this.cell), Math.floor((z - this.z0) / this.cell)]; }
  cellToIndex(ix, iz) { return this.index(ix, iz); }
  cellToWorld(i) { const ix = i % this.w, iz = (i - ix) / this.w; return { x: this.x0 + (ix + 0.5) * this.cell, z: this.z0 + (iz + 0.5) * this.cell }; }
  nearestWalkable(x, z, maxR = 8) {
    let [ix, iz] = this.worldToCell(x, z);
    const i0 = this.index(ix, iz);
    if (i0 >= 0 && this.walk[i0]) return i0;
    for (let r = 1; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const i = this.index(ix + dx, iz + dz);
        if (i >= 0 && this.walk[i]) return i;
      }
    }
    return -1;
  }
  /** A* over the grid with diagonal movement + corner checks */
  findPath(sx, sz, tx, tz) {
    const start = this.nearestWalkable(sx, sz), goal = this.nearestWalkable(tx, tz);
    if (start < 0 || goal < 0) return [];
    if (start === goal) return [this.cellToWorld(goal)];
    const N = this.walk.length;
    const g = new Float32Array(N).fill(Infinity);
    const f = new Float32Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const gx = goal % this.w, gz = (goal - gx) / this.w;
    const hfn = (i) => { const x = i % this.w, z = (i - x) / this.w; const dx = Math.abs(x - gx), dz = Math.abs(z - gz); return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz); };
    // binary heap
    const heap = [start]; const hf = [f[start] = hfn(start)];
    g[start] = 0;
    const push = (i) => {
      heap.push(i); hf.push(f[i]);
      let c = heap.length - 1;
      while (c > 0) { const p = (c - 1) >> 1; if (hf[p] <= hf[c]) break;[heap[p], heap[c]] = [heap[c], heap[p]];[hf[p], hf[c]] = [hf[c], hf[p]]; c = p; }
    };
    const pop = () => {
      const top = heap[0]; const li = heap.length - 1;
      heap[0] = heap[li]; hf[0] = hf[li]; heap.pop(); hf.pop();
      let c = 0;
      while (true) {
        let l = c * 2 + 1, r = l + 1, m = c;
        if (l < heap.length && hf[l] < hf[m]) m = l;
        if (r < heap.length && hf[r] < hf[m]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];[hf[m], hf[c]] = [hf[c], hf[m]]; c = m;
      }
      return top;
    };
    let iters = 0;
    while (heap.length && iters++ < 16000) {
      const cur = pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % this.w, cz = (cur - cx) / this.w;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const ni = this.index(cx + dx, cz + dz);
        if (ni < 0 || !this.walk[ni] || closed[ni]) continue;
        if (dx && dz && (!this.walk[this.index(cx + dx, cz)] || !this.walk[this.index(cx, cz + dz)])) continue;
        const step = Math.abs(this.floor[ni] - this.floor[cur]);
        if (step > 0.62) continue;
        const cost = g[cur] + (dx && dz ? 1.4142 : 1) + step * 3;
        if (cost < g[ni]) { g[ni] = cost; f[ni] = cost + hfn(ni); from[ni] = cur; push(ni); }
      }
    }
    if (from[goal] < 0 && start !== goal) return [];
    const out = []; let c = goal, guard = 0;
    while (c !== -1 && guard++ < N) { out.push(this.cellToWorld(c)); if (c === start) break; c = from[c]; }
    out.reverse();
    return out;
  }
  /* Line of walkability between two world points (for path smoothing) */
  walkableLine(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az); const steps = Math.ceil(d / (this.cell * 0.4));
    let prevFloor = null;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
      const [ix, iz] = this.worldToCell(x, z); const i = this.index(ix, iz);
      if (i < 0 || !this.walk[i]) return false;
      if (prevFloor !== null && Math.abs(this.floor[i] - prevFloor) > 0.62) return false;
      prevFloor = this.floor[i];
    }
    return true;
  }
  smoothPath(points) {
    if (points.length < 3) return points;
    const out = [points[0]]; let i = 0;
    while (i < points.length - 1) {
      let j = points.length - 1;
      while (j > i + 1 && !this.walkableLine(points[i].x, points[i].z, points[j].x, points[j].z)) j--;
      out.push(points[j]); i = j;
    }
    return out;
  }
}

/* =====================================================================
   PLAYER — Source-style movement: acceleration, slide, jump, crouch,
   camera bob, lean. Collides with AABBs and walks up small steps.
   ===================================================================== */
export class Player {
  constructor(camera) {
    this.cam = camera;
    this.pos = new THREE.Vector3(); // feet position
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.height = 1.75; this.radius = 0.38;
    this.crouch = 0; this.wantCrouch = false;
    this.onGround = true; this.sliding = false; this.slideT = 0;
    this.sprint = false; this.lean = 0; this.wantLean = 0;
    this.hp = 100; this.armor = 100; this.maxHp = 100;
    this.alive = true;
    this.kevlar = 0; this.helmet = 0; // shop-purchased damage reduction
    this.bob = 0; this.bobAmt = 0; this.landDip = 0; this.stepAcc = 0;
    this.recoilPitch = 0; this.recoilYaw = 0;
    this.shake = 0; this.camRoll = 0;
  }
  reset(spawn) {
    this.pos.set(spawn.position.x, spawn.position.y + 0.05, spawn.position.z);
    this.vel.set(0, 0, 0); this.yaw = spawn.yaw || 0; this.pitch = 0;
    this.hp = 100; this.armor = 100; this.alive = true; this.crouch = 0; this.sliding = false;
    this.onGround = true; this.lean = 0; this.landDip = 0; this.shake = 0;
    this.kevlar = 0; this.helmet = 0;
    this.recoilPitch = 0; this.recoilYaw = 0; this.recoilT = 0;
  }
  /**
   * Add camera kick. The offset is applied on top of the aim and then decays,
   * so a burst visibly climbs and settles instead of teleporting the view.
   */
  addRecoil(pitch, yaw, hold = 0.06) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
    this.recoilT = Math.max(this.recoilT || 0, hold);
  }
  /** advance recoil decay; held briefly so rapid fire accumulates before settling */
  updateRecoil(dt) {
    if (!this.recoilPitch && !this.recoilYaw && !(this.recoilT > 0)) return;
    if (this.recoilT > 0) { this.recoilT = Math.max(0, this.recoilT - dt); return; }
    const k = 1 - Math.exp(-9 * dt);
    this.recoilPitch -= this.recoilPitch * k;
    this.recoilYaw -= this.recoilYaw * k;
    if (Math.abs(this.recoilPitch) < 1e-5) this.recoilPitch = 0;
    if (Math.abs(this.recoilYaw) < 1e-5) this.recoilYaw = 0;
  }
  get eyeHeight() { return lerp(1.78, 1.06, this.crouch) - this.landDip; }
  eye(out = new THREE.Vector3()) { return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z); }
  forward(out = new THREE.Vector3()) {
    // include recoil so the shots that follow a kick travel where the muzzle points
    const pitch = this.pitch + this.recoilPitch, yaw = this.yaw + this.recoilYaw;
    return out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
  }
  /** update movement; input = {f,b,l,r,jump,sprint,crouch} */
  update(dt, input, colliders, audio) {
    if (!this.alive) { this.updateCamera(dt, 0); return; }
    const wish = _wish;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    wish.x = fx * (input.f - input.b) + rx * (input.r - input.l);
    wish.z = fz * (input.f - input.b) + rz * (input.r - input.l);
    const wl = Math.hypot(wish.x, wish.z);
    if (wl > 0) { wish.x /= wl; wish.z /= wl; }

    // ---- slide / crouch state
    this.wantCrouch = input.crouch;
    if (input.crouch && input.sprint && !this.wantCrouchPrev && this.onGround && this.slideT <= 0 && wl > 0 && this.crouch < 0.2) {
      this.sliding = true; this.slideT = 0.62;
      const speed = Math.hypot(this.vel.x, this.vel.z);
      this.slideDir = (this.slideDir || new THREE.Vector3()).set(wish.x || fx, 0, wish.z || fz).normalize();
      this.slideBoost = Math.max(speed, 6.2) * 1.28;
      if (audio) audio.land(false);
    }
    this.wantCrouchPrev = input.crouch;
    const targetCrouch = (input.crouch || this.sliding) ? 1 : 0;
    this.crouch = damp(this.crouch, targetCrouch, 12, dt);

    // ---- horizontal movement
    const baseSpeed = 5.4;
    let speed = baseSpeed;
    this.sprint = input.sprint && !input.crouch && wl > 0 && !this.sliding;
    if (this.sprint) speed = 8.4;
    if (input.crouch && !this.sliding) speed = 2.6;
    if (this.sliding) {
      this.slideT -= dt;
      const k = clamp(this.slideT / 0.62, 0, 1);
      const s = lerp(3.2, this.slideBoost, k * k);
      this.vel.x = this.slideDir.x * s; this.vel.z = this.slideDir.z * s;
      if (this.slideT <= 0 || !this.onGround) this.sliding = false;
    } else {
      // Quake-style acceleration: crisp starts/stops, momentum kept in the air
      const tx = wish.x * speed, tz = wish.z * speed;
      const accel = this.onGround ? (wl > 0 ? 72 : 38) : 15;
      const dvx = tx - this.vel.x, dvz = tz - this.vel.z;
      const dl = Math.hypot(dvx, dvz), maxt = accel * dt;
      if (dl > maxt && dl > 1e-6) { this.vel.x += dvx / dl * maxt; this.vel.z += dvz / dl * maxt; }
      else { this.vel.x = tx; this.vel.z = tz; }
    }

    // ---- gravity & jump (coyote time + buffered input: no swallowed jumps)
    if (this.onGround && this.vel.y <= 0) this.coyote = 0.12;
    else this.coyote = Math.max(0, (this.coyote || 0) - dt);
    this.vel.y -= 25 * dt;
    if (input.jump && !this._jumpHeld) this.jumpBuf = 0.14;
    this._jumpHeld = !!input.jump;
    this.jumpBuf = Math.max(0, (this.jumpBuf || 0) - dt);
    if (this.jumpBuf > 0 && this.coyote > 0) {
      this.vel.y = 7.3; this.onGround = false; this.coyote = 0; this.jumpBuf = 0;
      if (audio) audio.land(false);
    }

    // ---- integrate + collide
    // NEVER start a step buried in the world: if the ground is above the feet (bad
    // deploy point, geometry that moved under us), pop straight up onto it.
    const buried = colliders.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.3, 0.6);
    if (isFinite(buried) && buried > this.pos.y + 0.02) {
      this.pos.y = buried; if (this.vel.y < 0) this.vel.y = 0;
    }
    const prevY = this.pos.y;
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const h = lerp(1.75, 1.1, this.crouch);
    // horizontal collision (and step-up)
    const bx = this.pos.x, bz = this.pos.z;
    colliders.resolveCircle(this.pos, this.radius, this.pos.y + 0.25, h - 0.3);
    if (Math.abs(this.pos.x - bx) > 1e-4 || Math.abs(this.pos.z - bz) > 1e-4) {
      // kill velocity into the wall
      if (Math.abs(this.pos.x - bx) > 1e-4) this.vel.x *= 0.2;
      if (Math.abs(this.pos.z - bz) > 1e-4) this.vel.z *= 0.2;
    }
    const R = this.radius;
    // STEP UP: a low ledge is walked over instead of blocking. Only used when the
    // player is (or was just) grounded and the destination is genuinely a step
    // (< 0.55 m). Applying it mid-air on a slope used to yank the player onto
    // whatever surface the probe found, including the one they were falling past.
    if (this.onGround && this.vel.y <= 0.1) {
      const stepY = colliders.groundHeight(this.pos.x, this.pos.z, this.pos.y + 0.55, 0.6, R);
      if (isFinite(stepY) && stepY > this.pos.y + 0.02 && stepY - this.pos.y <= 0.55) {
        const probe = _stepProbe.set(this.pos.x, stepY + 0.02, this.pos.z);
        colliders.resolveCircle(probe, this.radius, probe.y + 0.25, h - 0.3);
        if (Math.abs(probe.x - this.pos.x) < 0.02 && Math.abs(probe.z - this.pos.z) < 0.02) {
          this.stepSmooth = Math.min(0.25, (this.stepSmooth || 0) + (stepY - this.pos.y));
          this.pos.y = stepY;
        }
      }
    }
    const preFallY = this.pos.y;
    this.pos.y += this.vel.y * dt;
    const falling = this.vel.y <= 0;
    let ground = colliders.groundHeight(this.pos.x, this.pos.z, this.pos.y, 0.6, R);
    // Deep probe: any surface between where we just were and where we are now is
    // one we crossed this step, so it must catch us (fast falls, slopes, drops).
    if (falling) {
      // 60 m window: even at terminal velocity a step can't carry the feet past
      // a slab that exists anywhere below — so a missed tile can never become a
      // bottomless hole that drops you out of the map.
      const deep = colliders.groundHeight(this.pos.x, this.pos.z, preFallY + 0.02, 60, R);
      if (isFinite(deep) && deep > ground) ground = deep;
    }
    if (!isFinite(ground)) ground = -1e9;
    // Catch the feet on any floor we fell past this step (swept test) — this is
    // what makes walking down slopes/off ledges smooth instead of falling through.
    const swept = falling && isFinite(ground) && ground <= preFallY + 0.02 && this.pos.y <= ground;
    // Small downward snap so descending stairs/ramps doesn't produce micro-airtime.
    const snapDist = this.onGround ? 0.35 : 0.02;
    const snapped = isFinite(ground) && ground > -1e8 && falling &&
      this.pos.y - ground <= snapDist && this.pos.y - ground >= -snapDist;
    if (swept || snapped) {
      if (!this.onGround) {
        const fall = Math.abs(this.vel.y);
        this.landDip = clamp(fall * 0.012, 0, 0.16);
        if (fall > 6 && audio) audio.land(true);
        else if (fall > 3 && audio) audio.land(false);
      }
      this.pos.y = ground; this.vel.y = 0; this.onGround = true;
    } else {
      this.onGround = false;
    }
    // tunnel-through-floor guard: falling fast can carry the feet past a floor slab
    // between frames, so groundHeight() finds nothing below and you fall into the
    // void below the map (grey screen). If we fell more than 0.3 m with no floor
    // below but there's a slab top we just fell through at our (x,z), snap back
    // up onto it instead of tumbling into the void.
    if (falling && !isFinite(ground) && (prevY - this.pos.y) > 0.3) {
      const list = colliders.query(this.pos.x - R, this.pos.z - R, this.pos.x + R, this.pos.z + R);
      let snapY = -Infinity;
      for (const b of list) {
        if (!colliders._inFootprint(b, this.pos.x, this.pos.z, R, R * R)) continue;
        if (b.maxY > this.pos.y + 0.02 && b.maxY <= prevY + 0.02 && b.maxY > snapY) snapY = b.maxY;
      }
      if (isFinite(snapY)) { this.pos.y = snapY; this.vel.y = 0; this.onGround = true; }
    }
    // fell below the world anyway: respawn on the nearest floor, not in mid-air
    if (this.pos.y < -25) {
      const g = colliders.groundHeight(this.pos.x, this.pos.z, 60, 60);
      this.pos.y = isFinite(g) ? g + 0.05 : 20;
      this.vel.y = 0; this.onGround = true;
    }
    // stepped up a ledge: smooth the camera instead of teleporting it
    if (this.onGround && this.pos.y - prevY > 0.08 && Math.abs(this.vel.y) < 0.01) {
      this.stepSmooth = Math.min(0.22, this.pos.y - prevY);
    }

    // ceiling check (head hits low box)
    const headList = colliders.query(this.pos.x - this.radius, this.pos.z - this.radius, this.pos.x + this.radius, this.pos.z + this.radius);
    for (const b of headList) {
      if (b.minY > this.pos.y + 0.2 && b.minY < this.pos.y + h && this.pos.x > b.minX && this.pos.x < b.maxX && this.pos.z > b.minZ && this.pos.z < b.maxZ) {
        if (this.vel.y > 0) this.vel.y = 0;
        this.pos.y = Math.min(this.pos.y, b.minY - h);
      }
    }

    // ---- footsteps & bob
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (this.onGround && hs > 1.2) {
      this.bob += dt * (this.sprint ? 13 : this.sliding ? 2 : 8.6) * clamp(hs / 5, 0.5, 1.4);
      this.bobAmt = damp(this.bobAmt, this.sprint ? 1.5 : 1, 8, dt);
      this.stepAcc += hs * dt;
      if (this.stepAcc > (this.sprint ? 2.2 : 2.8)) { this.stepAcc = 0; if (audio) audio.step(this.sprint); }
    } else this.bobAmt = damp(this.bobAmt, 0, 8, dt);

    this.lean = damp(this.lean, this.wantLean, 9, dt);
    this.updateCamera(dt, hs);
  }
  updateCamera(dt, hs) {
    const bobY = Math.sin(this.bob * 2) * 0.026 * this.bobAmt;
    const bobX = Math.cos(this.bob) * 0.032 * this.bobAmt;
    this.landDip = damp(this.landDip, 0, 9, dt);
    this.stepSmooth = damp(this.stepSmooth || 0, 0, 16, dt);
    this.shake = damp(this.shake, 0, 7, dt);
    const shk = this.shake * this.shake; // heavier hits read harder
    const c = this.cam;
    const lat = bobX + this.lean * 0.42 + (Math.random() - 0.5) * shk * 0.07;
    c.position.set(
      this.pos.x + Math.cos(this.yaw) * lat,
      this.pos.y + this.eyeHeight + bobY - this.stepSmooth + (Math.random() - 0.5) * shk * 0.06,
      this.pos.z - Math.sin(this.yaw) * lat
    );
    this.updateRecoil(dt);
    c.rotation.order = 'YXZ';
    c.rotation.y = this.yaw + this.recoilYaw - this.lean * 0.06;
    c.rotation.x = this.pitch + this.recoilPitch;
    c.rotation.z = -this.lean * 0.18 + Math.sin(this.bob) * 0.006 * this.bobAmt + (Math.random() - 0.5) * shk * 0.035;
  }
  damage(amount) {
    if (!this.alive) return 0;
    let dmg = amount;
    // kevlar vest reduces torso/body damage by 35%
    if (this.kevlar > 0) dmg *= 0.65;
    // helmet reduces headshot damage by 40% (headshots pass through as headshots)
    if (this.helmet > 0 && amount > this.armor) dmg *= 0.60; // headshot-ish reduction
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.55);
      this.armor -= absorbed; dmg -= absorbed;
    }
    this.hp -= dmg;
    this.shake = Math.min(1, this.shake + amount * 0.02);
    if (this.hp <= 0) { this.hp = 0; this.alive = false; }
    return amount;
  }
  heal(amount) {
    if (!this.alive) return 0;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    this.shake = Math.max(0, this.shake - 0.4);
    return amount;
  }
}
