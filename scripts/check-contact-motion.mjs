// Guard the displayed contact model against the old all-axis freeze and check
// the actual morphed mesh at the ball/plate interface, including oblique hits.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readFile } from 'node:fs/promises';
import { planClearRoute } from '../src/clear-route.js';
import { gravity } from '../src/rebound.js';
import { addInstrument, instrumentParts } from '../src/instrument.js';

const parts = instrumentParts(),
  texture = new THREE.Texture();
function checkEvent(e) {
  const c = e.contact,
    dt = c.end - c.start,
    { normal: n } = c;
  const root = new THREE.Group(),
    width = 0.37 + 0.085 * e.velocity;
  const item = addInstrument(root, parts, texture, [210, 180, 190], [230, 200, 210], {
    width,
    length: 1.95 + 0.52 * e.velocity,
    leanX: 0,
    leanY: 0,
    roll: Math.atan2(n.x, -n.y),
    flexible: true,
  });
  item.assembly.position.copy(c.center).addScaledVector(n, 0.32 + item.thickness / 2);
  item.assembly.position.z = -0.65;
  root.updateMatrixWorld(true);
  // Use the renderer's actual morphed triangles. Sample the flat working face
  // at the marble depth and the clamped root at rest and maximum compression.
  const ray = new THREE.Raycaster(),
    eps = Math.min(1e-6, 5e-5 / Math.sqrt(c.k));
  const vertex = new THREE.Vector3(),
    neutral = item.plank.geometry.attributes.position;
  let rootIndex = 0;
  for (let i = 1; i < neutral.count; i++) if (neutral.getZ(i) < neutral.getZ(rootIndex)) rootIndex = i;
  const rootAtRest = item.plank.getVertexPosition(rootIndex, vertex).clone();
  const peak = c.sample(c.peak);
  assert(Math.abs(peak.normalSpeed) < 1e-7 && peak.deflection > 0);
  assert(c.sample(0).velocity.distanceTo(e.incomingVelocity) < 1e-8);
  assert(c.sample(dt).velocity.distanceTo(e.outgoingVelocity) < 1e-8);
  assert(Math.abs(c.sample(dt).force) < 1e-6);
  assert(c.sample(0).normalSpeed > 0 && c.sample(dt).normalSpeed < 0);
  for (const t of [0, dt * 0.2, c.peak, dt * 0.82, dt]) {
    const state = c.sample(t);
    item.plank.morphTargetInfluences[0] = c.deflection(t) / item.thickness;
    assert(item.plank.getVertexPosition(rootIndex, vertex).distanceTo(rootAtRest) < 1e-8);
    ray.set(state.position, n);
    const hit = ray.intersectObject(item.plank, false)[0];
    assert(hit && Math.abs(hit.distance - 0.32) < 2e-6, `Sphere/mesh gap at ${e.t} + ${t}: ${hit?.distance}`);
    const a = c
      .sample(t + eps)
      .velocity.sub(c.sample(t - eps).velocity)
      .multiplyScalar(0.5 / eps);
    a.y += gravity;
    assert(a.addScaledVector(n, state.force).length() < 2e-5);
  }
  assert(c.deflection(-eps) === 0 && c.deflection(dt + 0.01) < c.deflection(dt));
  assert(Math.abs((c.deflection(dt + 1e-8) - c.deflection(dt)) / 1e-8 - c.sample(dt).normalSpeed) < 0.003);
  return peak.velocity.length();
}
const tests = [
  { hits: [], duration: 1 },
  { hits: [0, 0.092, 0.184, 0.3, 0.57, 0.87], duration: 0.88 },
  { hits: [0.3], duration: 0.315 },
  { hits: [1.1, 1.4, 2.55, 2.78, 3.2], duration: 4.6 },
];
let all = 0;
for (const test of tests) {
  const hits = test.hits.map((t, i) => ({ t, velocity: 0.7, beat: !(i % 2) }));
  const r = planClearRoute(hits, test.duration, 'elasticity-test');
  assert.deepEqual(
    r.events.map((e) => e.t),
    test.hits,
  );
  for (const e of r.events) {
    checkEvent(e);
    all++;
  }
  if (hits.length > 1) assert(r.events.some((e) => e.contact.sample(e.contact.peak).velocity.length() > 0.1));
}
for (const file of process.argv.slice(2)) {
  const p = JSON.parse(await readFile(file, 'utf8')),
    r = planClearRoute(p.hits, p.duration, p.title);
  assert.deepEqual(
    r.events.map((e) => e.t),
    p.hits.map((e) => e.t),
  );
  for (const e of r.events) {
    checkEvent(e);
    all++;
  }
}
console.log(`Verified entry, free slip, force, release and anchored mesh contact on ${all} impacts.`);
