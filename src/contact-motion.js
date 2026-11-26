// A light flexure supporting a rigid sphere. During contact its displacement is
// the ball's normal displacement. Mass-normalized Kelvin–Voigt force: k*q + c*q'.
// The support can push only. After separation the unloaded flexure relaxes.
import { Vector3 } from 'three';
import { gravity } from './rebound.js';

export function makeContact(event, normal, omega = 55) {
  const u = event.incomingVelocity.dot(normal);
  if (u <= 0.025) return null;
  const gn = -gravity * normal.y,
    zeta = 0.115;
  const k = omega ** 2,
    c = 2 * zeta * omega,
    decay = c / 2;
  const w = Math.sqrt(k - decay ** 2),
    eq = gn / k;
  const A = -eq,
    B = (u + decay * A) / w;
  function response(t) {
    const co = Math.cos(w * t),
      si = Math.sin(w * t),
      exp = Math.exp(-decay * t);
    const q = eq + exp * (A * co + B * si);
    const speed = exp * (u * co + ((gn - decay * u) / w) * si);
    return { q, speed, force: k * q + c * speed };
  }
  const peak = Math.atan2(u * w, decay * u - gn) / w;
  let lo = peak,
    hi = peak + Math.PI / w;
  if (response(hi).force >= 0) return null; // insufficient energy to lift off
  for (let i = 0; i < 34; i++) {
    const mid = (lo + hi) / 2;
    if (response(mid).force > 0) lo = mid;
    else hi = mid;
  }
  const duration = (lo + hi) / 2;
  const exit = response(duration);
  const tangent = new Vector3(-normal.y, normal.x, 0);
  const vt = tangent.dot(event.incomingVelocity),
    gt = -gravity * tangent.y;
  const slide = (t) => t * (vt + (gt * t) / 2);
  const along = [0, slide(duration)];
  if (gt && -vt / gt > 0 && -vt / gt < duration) along.push(slide(-vt / gt));
  const min = Math.min(...along),
    max = Math.max(...along);
  function sample(t) {
    const { q, speed, force } = response(t);
    return {
      position: event.position.clone().addScaledVector(tangent, slide(t)).addScaledVector(normal, q),
      velocity: tangent
        .clone()
        .multiplyScalar(vt + gt * t)
        .addScaledVector(normal, speed),
      deflection: q,
      normalSpeed: speed,
      force: Math.max(0, force),
    };
  }
  const release = sample(duration);
  return {
    type: 'contact',
    start: event.t,
    end: event.t + duration,
    a: event.position,
    b: release.position,
    normal,
    outgoing: release.velocity,
    peak,
    maxDeflection: response(peak).q,
    span: max - min,
    center: event.position.clone().addScaledVector(tangent, (max + min) / 2),
    k,
    c,
    sample,
    deflection(t) {
      if (t < 0) return 0;
      if (t < duration) return response(t).q;
      return exit.q * Math.exp((-k / c) * (t - duration));
    },
  };
}
