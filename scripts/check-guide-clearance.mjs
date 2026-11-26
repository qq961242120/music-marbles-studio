// Wall-view mesh regression. Test the rendered cross-sections independently of
// the planner's larger reservation envelopes, including brackets, rims and deck.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { planClearRoute } from '../src/clear-route.js';
import { makeGuide } from '../src/guide.js';
import { addInstrument, instrumentParts } from '../src/instrument.js';

const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
function hull(points) {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  function side(ps) {
    const s = [];
    for (const p of ps) {
      while (s.length > 1 && cross(s.at(-2), s.at(-1), p) <= 0) s.pop();
      s.push(p);
    }
    return s.slice(0, -1);
  }
  return side(sorted).concat(side(sorted.reverse()));
}
function bounds(pts) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1, y1];
}
const near = (a, b, margin = 0) =>
  a[0] < b[2] + margin && b[0] < a[2] + margin && a[1] < b[3] + margin && b[1] < a[3] + margin;
function convex(points) {
  const p = hull(points);
  return { p, b: bounds(p), vertices: points };
}
function overlap(a, b) {
  if (a.p.length < 3 || b.p.length < 3 || !near(a.b, b.b)) return false;
  for (const [s, t] of [
    [a, b],
    [b, a],
  ]) {
    for (let i = 0; i < s.p.length; i++) {
      const u = s.p[i],
        v = s.p[(i + 1) % s.p.length];
      if (t.p.every((p) => cross(u, v, p) <= 1e-8)) return false;
    }
  }
  return true;
}
function pointEdge(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
}
function ballIntersects(p, poly, r) {
  if (!near([p.x - r, p.y - r, p.x + r, p.y + r], poly.b)) return false;
  return (
    poly.p.every((a, i) => cross(a, poly.p[(i + 1) % poly.p.length], p) >= 0) ||
    poly.p.some((a, i) => pointEdge(p, a, poly.p[(i + 1) % poly.p.length]) < r - 0.0001)
  );
}
function object(parts) {
  return { parts, b: bounds(parts.flatMap((p) => p.p)) };
}
function objectsOverlap(a, b) {
  return near(a.b, b.b) && a.parts.some((p) => b.parts.some((q) => overlap(p, q)));
}
function guideObject(guide) {
  const mesh = makeGuide(guide.under, guide.kind, 1, true),
    parts = [];
  mesh.updateMatrixWorld(true);
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry,
      pos = g.attributes.position,
      vert = (i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
    if (g.type === 'TubeGeometry' && g.parameters.tubularSegments > 1) {
      const ring = g.parameters.radialSegments + 1;
      for (let i = 0; i < g.parameters.tubularSegments; i++)
        parts.push(convex(Array.from({ length: 2 * ring }, (_, k) => vert(i * ring + k))));
    } else if (g.type === 'BufferGeometry' && pos.count > 20) {
      for (let i = 0; i < pos.count - 2; i += 2)
        parts.push(convex([vert(i), vert(i + 1), vert(i + 2), vert(i + 3)]));
    } else parts.push(convex(Array.from({ length: pos.count }, (_, i) => vert(i))));
  });
  return object(parts);
}
function keyObject(e, shared, texture) {
  const root = new THREE.Group(),
    model = {
      width: 0.37 + 0.085 * e.velocity,
      length: 1.95 + 0.52 * e.velocity,
      leanX: 0,
      leanY: 0,
      flexible: true,
      roll: Math.atan2(e.normal.x, -e.normal.y),
    };
  const item = addInstrument(root, shared, texture, [180, 200, 180], [210, 180, 200], model);
  item.assembly.position.copy(e.keyCenter).addScaledVector(e.normal, 0.32 + item.thickness / 2);
  item.assembly.position.z = -0.65;
  root.updateMatrixWorld(true);
  const parts = [];
  item.assembly.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const { min, max } = g.boundingBox,
      p = [];
    const flex = o === item.plank ? e.contact.maxDeflection / o.scale.y : 0;
    for (const x of [min.x, max.x])
      for (const y of [min.y - flex, max.y])
        for (const z of [min.z, max.z]) p.push(new THREE.Vector3(x, y, z).applyMatrix4(o.matrixWorld));
    parts.push(convex(p));
  });
  return object(parts);
}
const files = process.argv.slice(2);
if (!files.length) throw new Error('用法：node scripts/check-guide-clearance.mjs <plan.json> [...]');
for (const f of files) {
  const input = JSON.parse(await readFile(f, 'utf8')),
    route = planClearRoute(input.hits, input.duration, input.title);
  assert.deepEqual(
    route.events.map((e) => e.t),
    input.hits.map((h) => h.t),
  );
  const shared = instrumentParts(),
    texture = new THREE.Texture(),
    keys = route.events.map((e) => keyObject(e, shared, texture)),
    rails = route.guides.map(guideObject);
  const project = (obj, sx, sy) =>
    object(
      obj.parts.map((part) => convex(part.vertices.map((p) => ({ x: p.x - sx * p.z, y: p.y - sy * p.z })))),
    );
  for (const [sx, sy] of [
    [0, 0],
    [0, 0.19],
    [-0.29, -0.25],
    [0.29, -0.25],
    [-0.29, 0.72],
    [0.29, 0.72],
  ]) {
    const seenKeys = keys.map((k) => project(k, sx, sy)),
      seenRails = rails.map((r) => project(r, sx, sy));
    const radius = 0.32 * Math.sqrt(1 + sx * sx + sy * sy);
    const violations = { rollingBallVsKey: [], guideVsKey: [], guideVsGuide: [] };
    route.guides.forEach((g, i) => {
      const points = g.curve.getPoints(Math.max(150, Math.ceil(g.curve.getLength() / 0.012))),
        bb = bounds(points);
      seenKeys.forEach((k, n) => {
        if (objectsOverlap(seenRails[i], k)) violations.guideVsKey.push([i, n]);
        if (
          near(k.b, bb, radius) &&
          points.some((p) => k.parts.some((part) => ballIntersects(p, part, radius)))
        )
          violations.rollingBallVsKey.push([i, n]);
      });
      for (let q = 0; q < i; q++)
        if (objectsOverlap(seenRails[i], seenRails[q])) violations.guideVsGuide.push([i, q]);
    });
    for (const [pair, pairs] of Object.entries(violations))
      assert.equal(pairs.length, 0, JSON.stringify({ pair, pairs, sx, sy, title: input.title }));
  }
  console.log(
    JSON.stringify({
      title: input.title,
      keys: keys.length,
      guides: rails.length,
      viewsChecked: 6,
      unexpectedOverlaps: 0,
    }),
  );
}
