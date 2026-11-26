import { createWorld } from './world.js';

const params = new URLSearchParams(location.search);
const id = params.get('job');
const canvas = document.querySelector('#render-canvas');
const world = createWorld(canvas);
window.__CAPTURE_MODE__ = true;

async function start() {
  if (!id) throw new Error('Missing job id');
  const response = await fetch(`/api/jobs/${id}/plan`);
  if (!response.ok) throw new Error(`Plan request failed: ${response.status}`);
  const plan = await response.json();
  world.loadPlan(plan);
  world.resize(plan.width || 1080, plan.height || 1920);
  world.seek(0);
  window.__seek = (time) => world.seek(time);
  window.__capture = async (time) => window.__seek(time);
  window.__restore = async () => {};
  window.__getSceneStats = () => world.getStats();
  window.__sampleBall = (time) => world.sampleBall(time);
  window.__projectBall = (time) => world.projectBall(time);
  window.__projectEventBoards = (index,time) => world.projectEventBoards(index,time);
  window.__projectLyric = (index) => world.projectLyric(index);
  window.__sampleLyric = (index) => world.sampleLyric(index);
  window.__sampleVelocity = (time) => world.sampleVelocity(time);
  window.__freeFlightVelocity = (time) => world.freeFlightVelocity(time);
  window.__contactResponse = (time) => world.contactResponse(time);
  window.__contactBall = (time) => world.contactBall(time);
  window.__physicsReport = () => world.physicsReport();
  window.__PLAN__ = plan;
  window.__SCENE_READY__ = true;
}

start().catch((error) => {
  window.__SCENE_ERROR__ = String(error.stack || error);
  console.error(error);
});
