// Two scene units represent one metre.
export const gravityMetres = 9.81;
export const metresPerUnit = 0.5;
export const gravity = gravityMetres / metresPerUnit;
const radius = 0.32;

function plateClearance(x, y, event, nx, ny) {
  const width = 0.37 + 0.085 * (event.velocity ?? 0.5);
  const halfThickness = Math.max(0.056, Math.min(0.085, 0.18 * width)) / 2;
  const dx = x - event.position.x,
    dy = y - event.position.y;
  const normal = Math.abs(dx * nx + dy * ny - radius - halfThickness) - halfThickness;
  const side = Math.abs(dx * ny - dy * nx) - width / 2;
  return Math.hypot(Math.max(0, normal), Math.max(0, side)) - radius;
}

// Pick a separating rebound at the current plate. A short, tangential tap
// advances a fast phrase; a spaced or accented note gets a readable apex.
export function rankedRebounds(event, interval, speed, previous, random, guided = null) {
  const strength = event.velocity ?? 0.5;
  const phraseAccent = event.accentStrength ?? 0;
  const incoming = event.incomingVelocity;
  const preferRise = phraseAccent >= .60 || interval >= 0.27 || ((event.beat || strength > 0.73) && event.index % 3 !== 1);
  const preferredDirection = (Math.sign(incoming.x) || 1) * (random() < 0.34 ? -1 : 1);
  const preferredApex = 0.2 + 0.14 * Math.max(strength, phraseAccent) + (event.beat ? 0.035 : 0);
  const choices = guided ?? [];
  const x0 = event.position.x,
    y0 = event.position.y;
  if (!guided) {
    const lifts = [preferredApex, 0.12, 0.19, 0.24, 0.32, 0.39, 0.46, 0.55].map((f) =>
      Math.min(speed * 0.93, gravity * interval * f),
    );
    for (const vy of [
      ...lifts,
      0,
      -0.16 * speed,
      -0.32 * speed,
      -0.46 * speed,
      -0.62 * speed,
      -0.75 * speed,
      -0.88 * speed,
      -0.97 * speed,
    ]) {
      for (const direction of [preferredDirection, -preferredDirection]) {
        const vx = direction * Math.sqrt(Math.max(0, speed * speed - vy * vy));
        const points = Array.from({ length: 12 }, (_, k) => {
          const t = (interval * (k + 1)) / 12;
          return { x: x0 + vx * t, y: y0 + vy * t - 0.5 * gravity * t * t };
        });
        choices.push({ vx, vy, points });
      }
    }
  }
  const ranked = [];
  for (const choice of choices) {
    const { vx, vy, points } = choice;
    const mx = incoming.x - vx,
      my = incoming.y - vy,
      magnitude = Math.hypot(mx, my);
    if (magnitude < 1e-8) continue;
    const nx = mx / magnitude,
      ny = my / magnitude,
      end = points.at(-1);
    let cost = (Math.sign(vx) === preferredDirection ? 0 : 0.22) + (choice.layoutCost ?? 0);
    if (phraseAccent > 0) {
      // Favour a readable change of direction. The leaf solver still determines
      // the actual deflection and release speed from the chosen face normal.
      const incidence = (incoming.x*nx + incoming.y*ny) / (incoming.length() || 1);
      cost += 2*phraseAccent*Math.max(0, .65-incidence);
    }
    if (!guided) {
      if (vy > 0 !== preferRise) cost += 1.7;
      if (vy > 0) cost += 0.7 * Math.abs(vy / (gravity * interval) - preferredApex);
    }
    cost += 0.38 * Math.max(0, Math.abs(end.x) - 2.6) ** 2;
    cost += 35 * Math.max(0, vx * nx + vy * ny + 0.02);
    const penalty = (gap) => (gap < -0.005 ? 0.7 - 125 * gap : 0);
    for (const p of points) cost += penalty(plateClearance(p.x, p.y, event, nx, ny));
    for (const wall of previous) {
      cost += 7 * Math.max(0, 0.66 - Math.hypot(end.x - wall.position.x, end.y - wall.position.y));
      for (const p of points) cost += penalty(plateClearance(p.x, p.y, wall, wall.normal.x, wall.normal.y));
    }
    for (const p of event.approach) {
      cost += penalty(plateClearance(p.x, p.y, event, nx, ny));
      // The next plate has yet to be banked. Reserve its landing site clear
      // of the earlier swept sphere so its eventual face cannot cut a flight.
      cost += 9 * Math.max(0, 0.62 - Math.hypot(end.x - p.x, end.y - p.y));
    }
    ranked.push({ ...choice, nx, ny, cost });
  }
  return ranked.sort((a, b) => a.cost - b.cost);
}
