// The artwork lives on a shallow wall. Reserving its XY footprint is conservative
// across depth and also prevents the visually confusing crossings seen head-on.
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sq = (x) => x * x;
export const ballRadius = 0.32;

function bounds(points, pad = 0) {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad };
}
function near(a, b, pad = 0) {
  return a.x0 <= b.x1 + pad && b.x0 <= a.x1 + pad && a.y0 <= b.y1 + pad && b.y0 <= a.y1 + pad;
}
function pointSegment(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return sq(a.x + dx * t - p.x) + sq(a.y + dy * t - p.y);
}
function orient(a, b, p) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
function segmentDistance(a, b, c, d) {
  const ac = orient(a, b, c),
    ad = orient(a, b, d),
    ca = orient(c, d, a),
    cb = orient(c, d, b);
  if (ac > 0 !== ad > 0 && ca > 0 !== cb > 0) return 0;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}
function line(points, radius) {
  return { points, radius, box: bounds(points, radius) };
}
function linesMeet(a, b, pad) {
  if (!near(a.box, b.box, pad)) return false;
  const lim = sq(a.radius + b.radius + pad);
  for (let i = 1; i < a.points.length; i++)
    for (let j = 1; j < b.points.length; j++) {
      if (segmentDistance(a.points[i - 1], a.points[i], b.points[j - 1], b.points[j]) < lim) return true;
    }
  return false;
}
// Project the near and far ends through the full usable camera angle. A long
// cantilever can cover a rail in the image although their centre lines miss.
function viewingEnvelope(points, lowZ, highZ) {
  const corners = [];
  for (const p of points)
    for (const k of [lowZ, highZ])
      for (const sx of [-0.29, 0.29])
        for (const sy of [-0.25, 0.72]) corners.push({ x: p.x - k * sx, y: p.y - k * sy });
  corners.sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (sorted) => {
    const h = [];
    for (const p of sorted) {
      while (h.length >= 2 && orient(h.at(-2), h.at(-1), p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  const hull = half(corners).concat(half(corners.reverse()));
  return { points: hull, box: bounds(hull) };
}
export function keyEnvelope(event, normal) {
  const width = 0.37 + 0.085 * (event.velocity ?? 0.5);
  const thickness = clamp(0.18 * width, 0.056, 0.085);
  // Includes the rear brace, wall pads and the small damped tilt of the tongue.
  const n = normal,
    u = { x: -n.y, y: n.x },
    p = event.keyCenter ?? event.position;
  const points = [];
  for (const [side, offset] of [
    [-1, 0.3],
    [1, 0.3],
    [1, ballRadius + thickness + Math.max(.27, event.maxDeflection ?? 0)],
    [-1, ballRadius + thickness + Math.max(.27, event.maxDeflection ?? 0)],
  ]) {
    points.push({
      x: p.x + offset * n.x + side * (width / 2 + 0.032) * u.x,
      y: p.y + offset * n.y + side * (width / 2 + 0.032) * u.y,
    });
  }
  const tip = -0.65 + 0.108 + 1.95 + 0.52 * (event.velocity ?? 0.5);
  return {
    points,
    box: bounds(points),
    index: event.index,
    viewedByBall: viewingEnvelope(points, -0.65, tip),
    viewedByRail: viewingEnvelope(points, -0.79, tip + 0.69),
  };
}
function inside(p, polygon) {
  let pos = false,
    neg = false;
  for (let i = 0; i < polygon.length; i++) {
    const c = orient(polygon[i], polygon[(i + 1) % polygon.length], p);
    pos ||= c > 0;
    neg ||= c < 0;
  }
  return !pos || !neg;
}
function meetsKey(path, key, pad) {
  if (!near(path.box, key.box, pad)) return false;
  const a = path.points,
    b = key.points,
    limit = sq(path.radius + pad);
  for (let i = 1; i < a.length; i++) {
    if (inside(a[i - 1], b) || inside(a[i], b)) return true;
    for (let j = 0; j < b.length; j++)
      if (segmentDistance(a[i - 1], a[i], b[j], b[(j + 1) % b.length]) < limit) return true;
  }
  return false;
}
export function guideDimensions(kind, unit = 1) {
  return { radius: unit * (kind === 'rail' ? 0.022 : 0.031), half: unit * (kind === 'rail' ? 0.069 : 0.143) };
}
// Offset by the surface normal, so the sphere is tangent to the upper guide rim
// even on an incline. Its lower, wall-facing braces are inside the reserved strip.
export function supportingCurve(THREE, curve, kind) {
  const { radius, half } = guideDimensions(kind);
  const offset = Math.sqrt(sq(ballRadius + radius) - sq(0.1)) + half;
  const points = curve.getPoints(48).map((p, i) => {
    const tangent = curve.getTangent(i / 48);
    const sign = Math.sign(tangent.x) || 1;
    return p.add(new THREE.Vector3(sign * tangent.y, -sign * tangent.x, 0).multiplyScalar(offset));
  });
  return new THREE.CatmullRomCurve3(points, false, 'centripetal');
}
export function reserveGuide(curve, under, kind) {
  const { radius, half } = guideDimensions(kind);
  // Tubes, deck and the projection of the support screws. The exit has no brackets.
  const stepCount = Math.min(1024, Math.max(40, Math.ceil(curve.getLength() / 0.16)));
  const metal = line(under.getPoints(stepCount), half + radius + (kind === 'exit' ? 0.014 : 0.205));
  return { metal, roll: line(curve.getPoints(stepCount), ballRadius + 0.008) };
}
export function reserveFlight(segment) {
  const dt = segment.end - segment.start;
  const n = Math.max(2, Math.ceil(dt / 0.036));
  return line(
    Array.from({ length: n + 1 }, (_, i) => {
      const t = (dt * i) / n;
      if (segment.type === 'contact') return segment.sample(t).position;
      return { x: segment.a.x + segment.vx * t, y: segment.a.y + segment.vy * t - 0.5 * segment.g * t * t };
    }),
    ballRadius + 0.005,
  );
}
export function conflicts(key, guide, flight, placed) {
  // Handoffs have an actual launch/landing gap, so no endpoint exclusions are necessary.
  if (
    guide &&
    (meetsKey(guide.roll, key.viewedByBall, 0.1) || meetsKey(guide.metal, key.viewedByRail, 0.045))
  )
    return true;
  for (let i = placed.length - 1; i >= 0; i--) {
    const prev = placed[i];
    if (prev.guide) {
      if (
        meetsKey(prev.guide.roll, key.viewedByBall, 0.1) ||
        meetsKey(prev.guide.metal, key.viewedByRail, 0.045)
      )
        return true;
      if (
        guide &&
        (linesMeet(guide.metal, prev.guide.metal, 0.66) ||
          linesMeet(guide.roll, prev.guide.metal, 0.1) ||
          linesMeet(prev.guide.roll, guide.metal, 0.1))
      )
        return true;
      if (flight.some((f) => linesMeet(f, prev.guide.metal, 0.065))) return true;
    }
    if (guide) {
      if (
        meetsKey(guide.roll, prev.key.viewedByBall, 0.1) ||
        meetsKey(guide.metal, prev.key.viewedByRail, 0.045)
      )
        return true;
      if (prev.flight.some((f) => linesMeet(f, guide.metal, 0.065))) return true;
    }
  }
  return false;
}
