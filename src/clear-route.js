// Compile a complete generated route before creating any meshes. Every option has
// the same musical times. Invalid spatial arrangements are retried, never drawn.
import * as THREE from 'three';
import { gravity as g, rankedRebounds } from './rebound.js';
import { keyEnvelope, reserveFlight, supportingCurve, reserveGuide, conflicts } from './route-clearance.js';

import { makeContact } from './contact-motion.js';
const guideKinds = ['rail', 'rail', 'brass', 'rail', 'glass'];
const v = (x, y) => new THREE.Vector3(x, y, 0);
const flightPoint = (s, t) => v(s.a.x + s.vx * t, s.a.y + s.vy * t - 0.5 * g * t * t);
function jump(a, velocity, start, dt) {
  const s = { type: 'jump', start, end: start + dt, a, vx: velocity.x, vy: velocity.y, vz: 0, g };
  s.b = flightPoint(s, dt);
  return s;
}
function flightEnd(s) {
  return v(s.vx, s.vy - g * (s.end - s.start));
}

// For a quadratic trough, solve the horizontal run with the real incoming
// speed. The lead-in and departure are genuine gravity-only flights.
function rollingMotion(a, dir, speed, slope0, slope1, start, dt) {
  const speed2 = speed * speed;
  function duration(run, n, times) {
    let elapsed = 0;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n,
        m = slope0 + (slope1 - slope0) * u;
      const dy = run * (slope0 * u + 0.5 * (slope1 - slope0) * u * u);
      elapsed += (run * Math.sqrt((1 + m * m) / Math.max(1e-9, speed2 - 2 * g * dy))) / n;
      if (times) times.push(elapsed);
    }
    return elapsed;
  }
  let lo = 0,
    hi = Math.max(0.5, speed * dt);
  while (duration(hi, 60) < dt) hi *= 2;
  for (let k = 0; k < 24; k++) {
    const mid = (hi + lo) / 2;
    if (duration(mid, 60) < dt) lo = mid;
    else hi = mid;
  }
  let run = (lo + hi) / 2;
  for (let k = 0; k < 4; k++) run *= dt / duration(run, 384);
  const times = [0];
  const actual = duration(run, 384, times);
  const b = v(a.x + dir * run, a.y + (run * (slope0 + slope1)) / 2);
  const curve = new THREE.QuadraticBezierCurve3(a, v(a.x + (dir * run) / 2, a.y + (run * slope0) / 2), b);
  return {
    type: 'rail',
    start,
    end: start + dt,
    curve,
    times,
    duration: actual,
    initialSpeedSquared: speed2,
    initialHeight: a.y,
    endSpeed: Math.sqrt(Math.max(0, speed2 + 2 * g * (a.y - b.y))),
  };
}
function guideChoices(event, dt, speed, expanded = false) {
  const ret = [];
  // Set the entry tangent first. This keeps a long pink or brass guide
  // shallow rather than letting an arbitrary free fall dictate a steep chute.
  const profiles = [
    ...[0.2, 0.25, 0.15, 0.32].flatMap((portion) =>
      [0.18, 0.42, 0.72, 1.05].map((grade) => [
        Math.min(dt * portion, 0.27),
        Math.min(dt * portion, 0.28),
        grade,
      ]),
    ),
  ];
  // If two long notes meet in a cramped corner, use independent flight times
  // on either side of the guide. The clearance tests are identical on retries.
  if (expanded)
    for (const [lead, tail] of [
      [0.35, 0.35],
      [0.4, 0.28],
      [0.27, 0.43],
      [0.42, 0.4],
    ]) {
      for (const grade of [0.38, 0.8, 1.35, 2.25, 3.4]) {
        profiles.push([Math.min(dt * lead, 0.52), Math.min(dt * tail, 0.48), grade]);
      }
    }
  for (const dir of [-1, 1])
    for (const [leadTime, tailTime, grade] of profiles) {
      const fall = g * leadTime;
      const disc = (1 + grade * grade) * speed * speed - fall * fall;
      if (disc <= 0) continue;
      const vy = (fall - grade * Math.sqrt(disc)) / (1 + grade * grade);
      const lateral = Math.sqrt(Math.max(0, speed * speed - vy * vy));
      if (lateral < 0.08 || vy > fall) continue;
      const vx = dir * lateral;
      const lead = jump(event.position, v(vx, vy), event.t, leadTime);
      const vin = flightEnd(lead),
        slope0 = vin.y / Math.abs(vx),
        slope1 = Math.min(-slope0 * 0.77, 0.48);
      const rail = rollingMotion(
        lead.b,
        dir,
        vin.length(),
        slope0,
        slope1,
        lead.end,
        dt - leadTime - tailTime,
      );
      const vout = rail.curve.getTangent(1).multiplyScalar(rail.endSpeed);
      const tail = jump(rail.curve.getPoint(1), vout, rail.end, tailTime);
      const points = [
        ...Array.from({ length: 4 }, (_, k) => flightPoint(lead, (leadTime * (k + 1)) / 4)),
        ...rail.curve.getPoints(12).slice(1),
        ...Array.from({ length: 4 }, (_, k) => flightPoint(tail, (tailTime * (k + 1)) / 4)),
      ];
      ret.push({
        vx,
        vy,
        points,
        segments: [lead, rail, tail],
        rail,
        arrival: flightEnd(tail),
        layoutCost: 2.5 * grade + 0.2 * Math.max(0, Math.abs(tail.b.x - event.position.x) - 8),
      });
    }
  return ret;
}
function endingChoices(event, time, speed) {
  if (time <= 0.05 || (speed * time) / 2 < 0.65) return null;
  const ret = [];
  for (const dir of [-1, 1])
    for (const factor of [0.22, 0.32, 0.46]) {
      const leadTime = Math.min(0.4, time * factor, (speed / g) * 0.7);
      const rollTime = time - leadTime;
      const vy = ((speed * speed) / g + g * leadTime * time) / (time + leadTime);
      if (vy >= speed) continue;
      const vx = dir * Math.sqrt(speed * speed - vy * vy);
      const lead = jump(event.position, v(vx, vy), event.t, leadTime),
        vin = flightEnd(lead);
      const end = lead.b.clone().addScaledVector(vin, rollTime / 2);
      const ending = {
        curve: new THREE.LineCurve3(lead.b, end),
        start: lead.end,
        end: event.t + time,
        remaining: rollTime,
        stopDuration: rollTime,
        arrivalSpeed: vin.length(),
        deceleration: vin.length() / rollTime,
        distance: (vin.length() * rollTime) / 2,
      };
      ret.push({
        vx,
        vy,
        points: [
          ...Array.from({ length: 5 }, (_, k) => flightPoint(lead, (leadTime * (k + 1)) / 5)),
          ...ending.curve.getPoints(12).slice(1),
        ],
        segments: [lead],
        ending,
      });
    }
  return ret;
}

function approachSamples(segments) {
  const out = [];
  for (const s of segments) {
    if (s.type === 'hold') continue;
    if (s.type === 'contact') {
      for (const f of [0, 0.5, 1]) out.push(s.sample((s.end - s.start) * f).position);
      continue;
    }
    if (s.type === 'rail') {
      out.push(...s.curve.getPoints(16));
      continue;
    }
    const dt = s.end - s.start,
      n = Math.ceil(dt / 0.045);
    for (let k = 0; k < n; k++) out.push(flightPoint(s, (dt * k) / n));
  }
  return out;
}
// At z=0 the tongue is a flat moving face. Test the complete sphere against
// its width and thickness, including entry/exit flights and neighbouring notes.
function sweptBall(segments) {
  const points = [];
  for (const s of segments) {
    if (s.type !== 'jump' && s.type !== 'contact') continue;
    const dt = s.end - s.start,
      n = Math.max(2, Math.ceil(dt / 0.009));
    for (let i = 0; i <= n; i++) {
      const t = (dt * i) / n,
        p = s.type === 'contact' ? s.sample(t).position : flightPoint(s, t);
      points.push({ x: p.x, y: p.y, t: s.start + t });
    }
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y);
    y1 = Math.max(y1, p.y);
  }
  return { points, x0, x1, y0, y1 };
}
function crossesTongue(sweep, contact, width) {
  const { center, normal: n } = contact;
  if (
    center.x < sweep.x0 - 1 ||
    center.x > sweep.x1 + 1 ||
    center.y < sweep.y0 - 1 ||
    center.y > sweep.y1 + 1
  )
    return false;
  const thickness = Math.min(0.085, Math.max(0.056, width * 0.18));
  for (const p of sweep.points) {
    if (p.t >= contact.start - 1e-8 && p.t <= contact.end + 1e-8) continue;
    const x = p.x - center.x,
      y = p.y - center.y;
    if (Math.abs(x) > 1 || Math.abs(y) > 1) continue;
    const h = x * n.x + y * n.y - 0.32 - contact.deflection(p.t - contact.start);
    const side = Math.max(0, Math.abs(y * n.x - x * n.y) - width / 2 - 0.009);
    if (Math.hypot(Math.max(-h, h - thickness, 0), side) < 0.32 - 1e-6) return true;
  }
  return false;
}
function seedFor(title, variant) {
  let h = 2166136261;
  for (const char of title) {
    h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  }
  return (h + Math.imul(variant, 2654435761)) >>> 0;
}
function randomAt(seed, index) {
  // The normal route and its repair branches use the existing Mulberry sequence.
  const state = (seed + Math.imul(index + 1, 0x6d2b79f5)) | 0;
  let value = Math.imul(state ^ (state >>> 15), 1 | state);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

export function planClearRoute(hits, duration, title, initialY = 0.61) {
  if (!hits.length) return { events: [], segments: [], guides: [], ending: null };
  const initial = [];
  let t0 = 0;
  const first = hits[0].t;
  const origin = v(0, initialY);
  if (first > 0.62) {
    t0 = first - 0.55;
    initial.push({ type: 'hold', start: 0, end: t0, a: origin, b: origin });
  }
  // A file may start on a hit with virtually no lead-in. Enter the frame
  // already in motion when that very first hit must launch a separate rail.
  const firstGuide = hits.length > 1 && hits[1].t - first > 0.78;
  const entryVy = firstGuide ? Math.min(0, -6.6 + g * (first - t0)) : first < 0.22 ? -2.2 : 0;
  const fastEntry = first < 0.1 && hits.length > 1 && hits[1].t - first < 0.16;
  const drop = jump(origin, v(fastEntry ? 5.8 : 1.1, fastEntry ? -4.2 : entryVy), t0, first - t0);
  initial.push(drop);
  const entrySweep = sweptBall(initial);
  const placed = [],
    stack = [];
  let attempts = 0,
    variant = 0,
    furthest = 0,
    retriesAtFrontier = 0,
    stalls = 0;
  function options(i) {
    const prev = placed.at(-1),
      prevMotion = prev?.travel ?? initial;
    const last = prevMotion.at(-1);
    const position = last.b;
    const incomingVelocity = prev?.arrival ?? flightEnd(drop),
      hit = hits[i];
    const event = { ...hit, index: i, position, incomingVelocity };
    event.approach = approachSamples([...placed.slice(-5, -1).flatMap((p) => p.travel), ...prevMotion]).slice(
      -60,
    );
    const next = hits[i + 1],
      dt = Math.max(0.00001, (next?.t ?? duration) - hit.t);
    const rem = Math.max(0, duration - hit.t);
    // Approximate speed used only to propose layout directions.
    const layoutSpeedFactor = next
      ? 0.84
      : Math.min(0.84, (rem * g * 0.92) / Math.max(0.000001, incomingVelocity.length()));
    const speed = incomingVelocity.length() * layoutSpeedFactor;
    const guided = next
      ? dt > 0.78
        ? guideChoices(event, dt, speed, variant >= 12)
        : null
      : endingChoices(event, rem, speed);
    if (!next && !guided?.length) {
      const n = incomingVelocity.clone().normalize();
      const normal = n.lengthSq() ? n : v(0, -1);
      return {
        event,
        choices: [{ vx: 0, vy: 0, nx: normal.x, ny: normal.y, segments: [] }],
        cursor: 0,
      };
    }
    const previous = placed.slice(-12).map((p) => p.event);
    const seed = seedFor(title, variant);
    const choices = rankedRebounds(event, dt, speed, previous, () => randomAt(seed, i), guided);
    // A detour should not turn repeated shallow taps into an accelerating
    // downward chute just to keep the horizontal run short.
    for (const c of choices) {
      const arrival = c.arrival?.length() ?? Math.hypot(c.vx, c.vy - g * dt);
      if (next) c.cost += 1.5 * Math.max(0, arrival - 10) ** 2;
    }
    choices.sort((a, b) => a.cost - b.cost);
    if (!next && rem <= 0.78 && (speed < 2.7 || variant > 40)) {
      // Very short or very low-energy tails may not have the distance to
      // reach a separate run-out ramp. Allow the film to end in motion.
      const n = incomingVelocity.clone().normalize();
      choices.push({ vx: 0, vy: 0, nx: n.x, ny: n.y || (n.x ? 0 : -1), segments: [] });
    }
    return { event, choices, cursor: 0 };
  }
  function candidate(entry, ch) {
    const e = entry.event,
      normal = v(ch.nx, ch.ny);
    const next = hits[e.index + 1],
      until = next?.t ?? duration;
    const width = 0.37 + 0.085 * (e.velocity ?? 0.5);
    // Select a stock leaf which can carry the full sliding contact patch.
    // The outgoing velocity always comes from the flexure, including on the last key.
    let contact;
    for (const stiffness of [50, 68, 92, 130, 185]) {
      contact = makeContact(e, normal, stiffness);
      if (
        contact &&
        contact.span < width - 0.035 &&
        contact.maxDeflection < 0.2 &&
        (!next || contact.end < until - 0.008)
      )
        break;
      contact = null;
    }
    if (!contact) return null;
    const k = placed.at(-1)?.nextGuideIndex ?? 0;
    const key = keyEnvelope(
      { ...e, keyCenter: contact.center, maxDeflection: contact.maxDeflection },
      normal,
    );
    const travel = [contact],
      dt = until - contact.end,
      vel = contact.outgoing;
    let rail, ending;
    if (ch.rail) {
      const leadTime = ch.segments[0].end - e.t;
      const tailTime = ch.segments[2].end - ch.segments[2].start;
      if (dt - leadTime - tailTime <= 0.03 || Math.abs(vel.x) < 0.1) return null;
      const lead = jump(contact.b, vel, contact.end, leadTime),
        vin = flightEnd(lead);
      const grade = -vin.y / Math.abs(vin.x);
      if (grade < 0.02 || grade > 4) return null;
      rail = rollingMotion(
        lead.b,
        Math.sign(vin.x),
        vin.length(),
        -grade,
        Math.min(grade * 0.77, 0.48),
        lead.end,
        dt - leadTime - tailTime,
      );
      const tail = jump(
        rail.curve.getPoint(1),
        rail.curve.getTangent(1).multiplyScalar(rail.endSpeed),
        rail.end,
        tailTime,
      );
      travel.push(lead, rail, tail);
    } else if (ch.ending) {
      // Leave the ramp at rest exactly at the end of the soundtrack. Solve
      // leadTime + |v_entry|²/(g*v_entry.y) = dt for the ballistic hand-off.
      const arrivalY = vel.x ** 2 / (g * dt - vel.y);
      const leadTime = (vel.y - arrivalY) / g;
      if (!(arrivalY > 0 && leadTime > 0.025 && leadTime < dt - 0.03)) return null;
      const lead = jump(contact.b, vel, contact.end, leadTime),
        vin = flightEnd(lead);
      const rollTime = dt - leadTime,
        arrivalSpeed = vin.length();
      const b = lead.b.clone().addScaledVector(vin, rollTime / 2);
      ending = {
        curve: new THREE.LineCurve3(lead.b, b),
        start: lead.end,
        end: until,
        remaining: rollTime,
        stopDuration: rollTime,
        arrivalSpeed,
        deceleration: arrivalSpeed / rollTime,
        distance: (arrivalSpeed * rollTime) / 2,
      };
      travel.push(lead);
    } else if (dt > 0) travel.push(jump(contact.b, vel, contact.end, dt));
    const curve = rail?.curve ?? ending?.curve;
    let path = null,
      spec = null;
    if (curve) {
      const kind = ending ? 'exit' : guideKinds[k % guideKinds.length];
      const under = supportingCurve(THREE, curve, kind);
      path = reserveGuide(curve, under, kind);
      spec = {
        curve,
        under,
        kind,
        start: rail?.start ?? ending.start,
        end: rail?.end ?? ending.end,
        isEnding: !!ending,
      };
    }
    const flight = travel.filter((s) => s.type !== 'rail').map(reserveFlight);
    if (conflicts(key, path, flight, placed)) return null;
    const sweep = sweptBall(travel);
    if (crossesTongue(sweep, contact, width) || crossesTongue(entrySweep, contact, width)) return null;
    for (const prev of placed) {
      if (crossesTongue(prev.sweep, contact, width) || crossesTongue(sweep, prev.event.contact, prev.width))
        return null;
    }
    const collision = {
      ...e,
      normal,
      outgoingVelocity: vel,
      contact,
      keyCenter: contact.center,
      restitution: -vel.dot(normal) / e.incomingVelocity.dot(normal),
    };
    delete collision.approach;
    return {
      event: collision,
      sweep,
      width,
      key,
      guide: path,
      spec,
      flight,
      travel,
      ending,
      arrival: travel.at(-1).type === 'jump' ? flightEnd(travel.at(-1)) : vel,
      nextGuideIndex: k + (rail ? 1 : 0),
    };
  }
  while (placed.length < hits.length) {
    const i = placed.length;
    // After a deep rewind, count retries against the area being rebuilt.
    // A distant abandoned frontier would otherwise keep widening each retry.
    if (i > furthest || i + 24 < furthest) {
      furthest = i;
      retriesAtFrontier = 0;
      stalls = 0;
    }
    const entry = stack[i] ?? (stack[i] = options(i));
    let success = null;
    while (entry.cursor < entry.choices.length && !success) {
      success = candidate(entry, entry.choices[entry.cursor++]);
      attempts++;
    }
    if (success) {
      placed.push(success);
      continue;
    }
    stack.pop();
    if (placed.length) placed.pop();
    // Escape a dead end that was established several landings earlier. Retain
    // the accepted prefix and vary the decision at a previous branch.
    if (++stalls > 12 || !placed.length) {
      if (++variant > 600) throw Error(`无法在第 ${furthest + 1} 个落点附近安排无交叠的轨道。`);
      // A denser phrase can run into a guide built more than twelve notes ago.
      // Widen the search only while retries keep hitting the same obstruction.
      const lookback = 3 + (variant % 12) + 8*Math.floor(retriesAtFrontier++/4);
      const from = Math.max(0, Math.min(placed.length, furthest - lookback));
      placed.length = from;
      stack.length = from;
      stalls = 0;
      // Move the viable alternative to the front without changing any hit time.
      const revised = options(from);
      if (revised.choices.length > 1) {
        const offset =
          1 + Math.floor(randomAt(seedFor(title, variant), from) * Math.min(8, revised.choices.length - 1));
        revised.choices = [...revised.choices.slice(offset), ...revised.choices.slice(0, offset)];
      }
      stack[from] = revised;
    }
  }
  return {
    events: placed.map((p) => p.event),
    segments: [...initial, ...placed.flatMap((p) => p.travel)],
    guides: placed.filter((p) => p.spec).map((p) => p.spec),
    ending: placed.at(-1)?.ending ?? null,
    attempts,
    variant,
  };
}
