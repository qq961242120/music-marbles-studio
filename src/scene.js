import { createIcons, Upload, FileAudio, Download, Play, Pause, RefreshCw, Check, AlertCircle, Music2, Activity, Route, Captions } from 'lucide';
import { createWorld } from './world.js';
import './style.css';
import exportSettings from '../export-settings.json';

const icons = { Upload, FileAudio, Download, Play, Pause, RefreshCw, Check, AlertCircle, Music2, Activity, Route, Captions };
const $ = (selector) => document.querySelector(selector);
const canvas = $('#scene');
const world = createWorld(canvas);
const audio = new Audio();
audio.preload = 'auto';
let plan = null;
let job = null;
let pollTimer = null;
let demoPlaying = !matchMedia('(prefers-reduced-motion: reduce)').matches;
let demoTime = 0;
let previousFrame = performance.now();
let lastPlanPhase = '';
let isResult = false;

function formatOutput(settings) {
  const format = `${settings.width ?? 1080} × ${settings.height ?? 1920} · ${settings.fps} fps`;
  return settings.audioDelayFrames ? `${format} · 声音延后 ${settings.audioDelayFrames} 帧` : format;
}
$('#output-spec').textContent = formatOutput(exportSettings);

function demoPlan() {
  const hits = [];
  for (let i = 0; i < 34; i += 1) {
    const gap = i % 9 === 7 ? 1.05 : (i % 5 === 2 ? 0.24 : 0.43);
    hits.push({ t: 0.35 + i * 0.41 + (i > 8 ? Math.floor(i / 9) * 0.45 : 0), pitch: 58 + [0, 4, 7, 2, 9, 5, 4][i % 7], velocity: i % 4 === 0 ? 0.9 : 0.55, gap });
  }
  return { title: '场景预览', duration: 18, bpm: 112, hits, lyrics: [], analysis: { railCount: 4 } };
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  world.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
}

function setStatus(title, detail = '') {
  $('#status-title').textContent = title;
  $('#status-detail').textContent = detail;
}

function setProgress(value) {
  const percent = Math.max(0, Math.min(100, Math.round(value || 0)));
  $('#progress-fill').style.transform = `scaleX(${percent / 100})`;
  $('#progress-value').textContent = `${percent}%`;
}

function setStep(name, state) {
  const element = $(`[data-step="${name}"]`);
  element.dataset.state = state;
  element.querySelector('.step-icon').innerHTML = state === 'done' ? '<i data-lucide="check"></i>' : '';
  createIcons({ icons, attrs: { 'stroke-width': 1.8 } });
}

function updateStats(nextPlan) {
  $('#stat-notes').textContent = nextPlan.hits?.length || 0;
  $('#stat-bpm').textContent = nextPlan.bpm ? Math.round(nextPlan.bpm) : '—';
  $('#stat-rails').textContent = nextPlan.analysis?.railCount ?? '—';
  $('#stat-duration').textContent = `${Number(nextPlan.duration).toFixed(2)} 秒`;
  $('#lyric-source').textContent = nextPlan.lyrics?.length
    ? `${nextPlan.lyrics.length} 句 · ${nextPlan.analysis?.lyricsSource || '可靠匹配'}`
    : '无可靠歌词，保留纯画面';
}

async function loadJobPlan(id) {
  const response = await fetch(`/api/jobs/${id}/plan`);
  if (!response.ok) return;
  plan = await response.json();
  world.loadPlan(plan);
  world.seek(0);
  audio.src = `/api/jobs/${id}/${plan.audioDelayFrames ? 'soundtrack' : 'audio'}`;
  updateStats(plan);
  $('#song-name').textContent = plan.title;
  $('#analysis-note').textContent = `由音频独立生成 · ${plan.analysis?.onsetMethod || '混音起音分析'}`;
  setStep('analyze', 'done');
  setStep('layout', 'done');
  demoPlaying = false;
  resize();
}

function showResult(id) {
  isResult = true;
  audio.pause();
  const video = $('#result-video');
  video.src = `/api/jobs/${id}/video`;
  video.hidden = false;
  canvas.hidden = true;
  $('#playback-controls').hidden = true;
  $('#download-link').href = `/api/jobs/${id}/video?download=1`;
  $('#download-link').hidden = false;
  setStep('render', 'done');
  setProgress(100);
  setStatus('视频已生成', '整曲画面与音轨已合成');
}

async function pollJob(id) {
  try {
    const response = await fetch(`/api/jobs/${id}`);
    if (!response.ok) throw new Error('无法读取生成进度');
    job = await response.json();
    setProgress(job.progress);
    const phase = job.phase;
    if (phase === 'queued') setStatus('等待处理', '生成任务已进入本机队列');
    if (phase === 'analyzing') {
      setStatus('正在听懂这首歌', '分析旋律起音、重音、乐句和停顿');
      setStep('analyze', 'active');
      setStep('layout', 'waiting');
      setStep('render', 'waiting');
    }
    if (phase === 'rendering') {
      if (lastPlanPhase !== 'rendering') await loadJobPlan(id);
      setStatus('正在编排并逐帧渲染', `${job.frame || 0} / ${job.totalFrames || '—'} 帧 · ${formatOutput(plan || exportSettings)}`);
      setStep('render', 'active');
    }
    if (phase === 'done') {
      if (!plan) await loadJobPlan(id);
      showResult(id);
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (phase === 'error') {
      setStatus('生成失败', job.error || '请换一首歌曲重试');
      $('#error-box').hidden = false;
      $('#error-box').textContent = job.error || '未知错误';
      clearInterval(pollTimer);
      pollTimer = null;
    }
    lastPlanPhase = phase;
  } catch (error) {
    setStatus('连接中断', error.message);
  }
}

async function uploadFile(file) {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['mp3', 'm4a', 'wav'].includes(extension)) {
    $('#error-box').hidden = false;
    $('#error-box').textContent = '请选择 MP3、M4A 或 WAV 音频文件。';
    return;
  }
  if (file.size > 200 * 1024 * 1024) {
    $('#error-box').hidden = false;
    $('#error-box').textContent = '单个音频文件不能超过 200 MB。';
    return;
  }
  $('#error-box').hidden = true;
  $('#welcome').hidden = true;
  $('#job-panel').hidden = false;
  $('#download-link').hidden = true;
  $('#result-video').hidden = true;
  $('#result-video').removeAttribute('src');
  canvas.hidden = false;
  $('#playback-controls').hidden = false;
  isResult = false;
  plan = null;
  job = null;
  lastPlanPhase = '';
  audio.pause();
  audio.removeAttribute('src');
  $('#song-name').textContent = file.name;
  setProgress(1);
  setStatus('正在传入歌曲', `${(file.size / 1024 / 1024).toFixed(1)} MB · 仅在本机处理`);
  try {
    const response = await fetch(`/api/jobs?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '上传失败');
    job = result;
    pollTimer = setInterval(() => pollJob(result.id), 800);
    await pollJob(result.id);
  } catch (error) {
    setStatus('无法开始生成', error.message);
    $('#error-box').hidden = false;
    $('#error-box').textContent = error.message;
  }
}

function togglePlayback() {
  if (isResult) return;
  if (audio.src) {
    if (audio.paused) audio.play();
    else audio.pause();
  } else {
    demoPlaying = !demoPlaying;
  }
  updatePlayIcon();
}

function updatePlayIcon() {
  const playing = audio.src ? !audio.paused : demoPlaying;
  $('#play-button').innerHTML = `<i data-lucide="${playing ? 'pause' : 'play'}"></i>`;
  $('#play-button').setAttribute('aria-label', playing ? '暂停预览' : '播放预览');
  createIcons({ icons, attrs: { 'stroke-width': 1.8 } });
}

function animate(now) {
  const dt = Math.min(0.1, (now - previousFrame) / 1000);
  previousFrame = now;
  if (!isResult) {
    if (audio.src && !audio.paused) world.seek(audio.currentTime);
    else if (demoPlaying && !audio.src && plan) {
      demoTime = (demoTime + dt) % plan.duration;
      world.seek(demoTime);
    }
    if (audio.src) $('#time-slider').value = audio.duration ? (audio.currentTime / audio.duration) * 1000 : 0;
  }
  requestAnimationFrame(animate);
}

plan = demoPlan();
world.loadPlan(plan);
resize();
world.seek(0);
updateStats(plan);
createIcons({ icons, attrs: { 'stroke-width': 1.8 } });
updatePlayIcon();
requestAnimationFrame(animate);
addEventListener('resize', resize);
audio.addEventListener('play', updatePlayIcon);
audio.addEventListener('pause', updatePlayIcon);
audio.addEventListener('ended', updatePlayIcon);
$('#play-button').addEventListener('click', togglePlayback);
$('#time-slider').addEventListener('input', (event) => {
  const duration = Number.isFinite(audio.duration) && audio.src ? audio.duration : plan?.duration || 0;
  const time = (Number(event.target.value) / 1000) * duration;
  if (audio.src && audio.duration) audio.currentTime = time;
  demoPlaying = false;
  world.seek(time);
  updatePlayIcon();
});

const picker = $('#file-picker');
$('#choose-file').addEventListener('click', () => picker.click());
$('#new-song').addEventListener('click', () => picker.click());
picker.addEventListener('change', () => {
  if (picker.files[0]) uploadFile(picker.files[0]);
  picker.value = '';
});
const dropzone = $('#dropzone');
for (const eventName of ['dragenter', 'dragover']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
}
dropzone.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  if (file) uploadFile(file);
});
dropzone.addEventListener('click', (event) => {
  if (!event.target.closest('button')) picker.click();
});
dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    picker.click();
  }
});

window.__seek = (time) => {
  demoPlaying = false;
  world.seek(time);
};
window.__capture = async (time) => window.__seek(time);
window.__restore = async () => {};
window.__getSceneStats = () => world.getStats();
window.__CAPTURE_MODE__ = new URLSearchParams(location.search).has('capture');
if (window.__CAPTURE_MODE__) {
  demoPlaying = false;
  const time = Number(new URLSearchParams(location.search).get('t') || 0);
  world.seek(time);
}
window.__SCENE_READY__ = true;
