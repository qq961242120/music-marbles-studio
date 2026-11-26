import http from 'node:http';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { renderJob } from './render-job.mjs';

const execFile = promisify(execFileCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(root, 'data', 'jobs');
const jobs = new Map();
const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(valueAfter('--port', process.env.PORT || 7100));
const host = valueAfter('--host', '127.0.0.1');
const production = process.env.NODE_ENV === 'production';
await mkdir(dataRoot, { recursive: true });
for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(dataRoot, entry.name);
  const planPath = path.join(dir, 'plan.json');
  if (!existsSync(planPath)) continue;
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const audioPath = ['.m4a', '.mp3', '.wav'].map((extension) => path.join(dir, `source${extension}`)).find(existsSync);
  if (!audioPath) continue;
  const statusPath = path.join(dir, 'status.json');
  const status = existsSync(statusPath) ? JSON.parse(await readFile(statusPath, 'utf8')) : {};
  const outputPath = path.join(dir, 'output.mp4');
  const hasOutput = existsSync(outputPath);
  jobs.set(entry.name, {
    id: entry.name,
    dir,
    originalName: `${plan.title || 'music-marbles'}${path.extname(audioPath)}`,
    audioPath,
    planPath,
    outputPath: hasOutput ? outputPath : null,
    phase: hasOutput ? 'done' : status.phase || 'error',
    progress: hasOutput ? 100 : status.progress || 0,
    frame: status.frame || 0,
    totalFrames: status.totalFrames || 0,
    error: hasOutput ? null : status.error || '任务尚未导出，请重新生成。',
    createdAt: status.createdAt || null,
  });
}

let queue = Promise.resolve();

function publicJob(job) {
  return {
    id: job.id,
    phase: job.phase,
    progress: job.progress,
    frame: job.frame || 0,
    totalFrames: job.totalFrames || 0,
    error: job.error || null,
    createdAt: job.createdAt,
  };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function jobFrom(request, response) {
  const parts = request.url.split('?')[0].split('/');
  const id = parts[3];
  const job = jobs.get(id);
  if (!job) json(response, 404, { error: '任务不存在，请重新拖入歌曲。' });
  return job;
}

async function serveJobFile(request, response, job, kind) {
  const paths = { audio: job.audioPath, plan: job.planPath, video: job.outputPath,
    soundtrack: path.join(job.dir, 'soundtrack.m4a') };
  const filePath = paths[kind];
  if (!filePath || !existsSync(filePath)) {
    json(response, 404, { error: '文件尚未生成。' });
    return;
  }
  const info = await stat(filePath);
  const audioTypes = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };
  const types = { soundtrack: 'audio/mp4', audio: audioTypes[path.extname(job.audioPath)] || 'application/octet-stream', plan: 'application/json; charset=utf-8', video: 'video/mp4' };
  const headers = { 'Content-Type': types[kind], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const download = new URL(request.url, 'http://local').searchParams.has('download');
  if (download) headers['Content-Disposition'] = `attachment; filename="music-marbles.mp4"; filename*=UTF-8''${encodeURIComponent(`${path.parse(job.originalName).name}-音乐弹珠.mp4`)}`;
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416).end();
      return;
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(info.size - 1, Number(match[2])) : info.size - 1;
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': info.size });
  createReadStream(filePath).pipe(response);
}

async function analyze(job) {
  const python = process.env.MARBLES_PYTHON || path.join(root, '.venv', 'bin', 'python');
  if (!existsSync(python)) throw new Error('缺少音频分析环境，请先运行 npm run setup。');
  job.phase = 'analyzing';
  job.progress = 2;
  await execFile(python, [
    path.join(root, 'analysis', 'analyze.py'), job.audioPath, job.planPath,
    '--ffmpeg', ffmpegPath,
    '--title', path.parse(job.originalName).name,
  ], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
  job.progress = 8;
}

async function runJob(job) {
  try {
    await analyze(job);
    const result = await renderJob(job, port, (update) => Object.assign(job, update));
    job.outputPath = result.outputPath;
    job.media = result.media;
    job.totalFrames = result.totalFrames;
    job.frame = result.totalFrames;
    job.phase = 'done';
    job.progress = 100;
    await writeFile(path.join(job.dir, 'status.json'), JSON.stringify(publicJob(job), null, 2));
  } catch (error) {
    job.phase = 'error';
    job.error = String(error.message || error);
    console.error(`[job ${job.id}]`, job.error);
  }
}

async function receiveAudio(request, response) {
  const name = new URL(request.url, 'http://local').searchParams.get('name') || 'song.m4a';
  const extension = path.extname(name).toLowerCase();
  if (!['.mp3', '.m4a', '.wav'].includes(extension)) {
    json(response, 415, { error: '仅支持 MP3、M4A 或 WAV。' });
    return;
  }
  const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const dir = path.join(dataRoot, id);
  await mkdir(dir, { recursive: true });
  const audioPath = path.join(dir, `source${extension}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 200 * 1024 * 1024) {
      json(response, 413, { error: '音频不能超过 200 MB。' });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  }
  if (!size) {
    json(response, 400, { error: '音频文件为空。' });
    return;
  }
  await writeFile(audioPath, Buffer.concat(chunks));
  const job = {
    id,
    dir,
    originalName: name,
    audioPath,
    planPath: path.join(dir, 'plan.json'),
    outputPath: null,
    phase: 'queued',
    progress: 1,
    createdAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  queue = queue.then(() => runJob(job)).catch((error) => console.error(error));
  json(response, 202, publicJob(job));
}

async function serveProduction(request, response) {
  const pathname = decodeURIComponent(new URL(request.url, 'http://local').pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const dist = path.join(root, 'dist');
  let filePath = path.resolve(dist, requested);
  if (!filePath.startsWith(dist + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || !(await stat(filePath)).isFile()) {
    response.writeHead(404).end();
    return;
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
}

let vite;
if (!production) {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://local').pathname;
    if (request.method === 'POST' && pathname === '/api/jobs') {
      await receiveAudio(request, response);
      return;
    }
    if (pathname.startsWith('/api/jobs/')) {
      const job = jobFrom(request, response);
      if (!job) return;
      const parts = pathname.split('/');
      const resource = parts[4];
      if (!resource) json(response, 200, publicJob(job));
      else if (['audio', 'soundtrack', 'plan', 'video'].includes(resource)) await serveJobFile(request, response, job, resource);
      else json(response, 404, { error: '未知任务资源。' });
      return;
    }
    if (production) await serveProduction(request, response);
    else vite.middlewares(request, response, () => {
      response.writeHead(404).end();
    });
  } catch (error) {
    console.error(error);
    if (!response.headersSent) json(response, 500, { error: String(error.message || error) });
    else response.end();
  }
});

server.listen(port, host, () => {
  console.log(`\n音乐弹珠已启动：http://${host}:${port}\n把一首 MP3、M4A 或 WAV 拖进页面即可。\n`);
});
