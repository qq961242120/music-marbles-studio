import { readFile } from 'node:fs/promises';

const plan = JSON.parse(await readFile(process.argv[2], 'utf8'));
const errors = [];
let previous = -Infinity;
let rapid = 0;
let longRails = 0;
for (const hit of plan.hits) {
  if (hit.t <= previous) errors.push(`非递增碰撞时刻：${hit.t}`);
  const gap = hit.t - previous;
  if (gap > 0 && gap < 0.25) rapid += 1;
  if (gap > 0.78) longRails += 1;
  if (hit.t < 0 || hit.t >= plan.duration) errors.push(`碰撞越界：${hit.t}`);
  previous = hit.t;
}
const quantization = 1000 / (plan.fps * 2);
const result = {
  title: plan.title,
  duration: plan.duration,
  fps: plan.fps,
  hits: plan.hits.length,
  rapidIntervals: rapid,
  longRails,
  lyrics: plan.lyrics.length,
  maxFrameQuantizationMs: quantization,
  withinTwoFrameTarget: quantization <= 2000 / plan.fps,
  errors,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length || quantization > 2000 / plan.fps) process.exit(1);
