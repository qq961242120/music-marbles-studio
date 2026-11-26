import { chromium } from 'playwright-core';
import ffmpegPath from 'ffmpeg-static';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    chromium.executablePath(),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

// The live preview and the muxer use the same encoded audio. Keep source
// audio on its original clock for music analysis and hit placement.
async function prepareDelayedAudio(job, delayMilliseconds) {
  const soundtrack = path.join(job.dir, 'soundtrack.m4a');
  const temporary = path.join(job.dir, `soundtrack-${randomUUID()}.m4a`);
  try {
    await execFile(ffmpegPath, [
      '-v', 'error', '-i', job.audioPath, '-map', '0:a:0',
      '-af', `asetpts=PTS-STARTPTS,adelay=${delayMilliseconds}:all=1`,
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temporary,
    ]);
    await rename(temporary, soundtrack);
    return soundtrack;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function renderJob(job, port, onProgress) {
  const plan = JSON.parse(await readFile(job.planPath, 'utf8'));
  const delayFrames = plan.audioDelayFrames ?? 0; // Legacy exports use the original audio clock.
  const delaySeconds = delayFrames / plan.fps;
  const executablePath = chromeExecutable();
  if (!executablePath) throw new Error('未找到 Chrome。请安装 Chrome，或设置 CHROME_PATH。');
  const audioPath = delayFrames ? await prepareDelayedAudio(job, 1000 * delaySeconds) : job.audioPath;
  const outputPath = path.join(job.dir, 'output.mp4');
  const stagingPath = path.join(job.dir, `render-${randomUUID()}.mp4`);
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--ignore-gpu-blocklist',
      '--enable-gpu',
      '--use-angle=metal',
      '--hide-scrollbars',
    ],
  });
  let ffmpeg;
  let ffmpegError = '';
  try {
    const page = await browser.newPage({
      viewport: { width: plan.width || 1080, height: plan.height || 1920 },
      deviceScaleFactor: 1,
    });
    page.setDefaultTimeout(60000);
    await page.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.goto(`http://127.0.0.1:${port}/render.html?job=${encodeURIComponent(job.id)}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__SCENE_READY__ === true || window.__SCENE_ERROR__, { timeout: 60000 });
    const sceneError = await page.evaluate(() => window.__SCENE_ERROR__);
    if (sceneError) throw new Error(sceneError);
    if (pageErrors.length) throw new Error(pageErrors.join('\n'));

    const sceneFrames = Math.ceil(plan.duration * plan.fps);
    const totalFrames = sceneFrames + delayFrames;
    onProgress({ phase: 'rendering', frame: 0, totalFrames, progress: 8 });
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(plan.fps), '-i', 'pipe:0',
      '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      ...(delayFrames ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-t', String(plan.duration)]),
      '-movflags', '+faststart', stagingPath,
    ];
    ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    // The write callback rejects a pending frame if the encoder exits mid-write.
    ffmpeg.stdin.on('error', () => {}); // The callback and child exit carry the error.
    ffmpeg.stderr.on('data', (chunk) => {
      ffmpegError = (ffmpegError + chunk.toString()).slice(-12000);
    });
    const encoding = new Promise((resolve, reject) => {
      ffmpeg.once('error', reject);
      ffmpeg.once('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 编码失败（${code}）：${ffmpegError}`)));
    });
    encoding.catch(() => {}); // Also handled below; prevents a rejected encoder from killing the service on an earlier page error.

    let image;
    for (let frame = 0; frame < totalFrames; frame += 1) {
      if (ffmpeg.exitCode !== null) break;
      if (frame < sceneFrames) {
        await page.evaluate((time) => window.__seek(time), frame / plan.fps);
        image = await page.screenshot({ type: 'jpeg', quality: 92, timeout: 60000 });
      } // Hold the last rendered frame while the delayed soundtrack finishes.
      await new Promise((resolve, reject) => ffmpeg.stdin.write(image, error => error ? reject(error) : resolve()));
      if (frame % 15 === 0 || frame === totalFrames - 1) {
        onProgress({
          phase: 'rendering',
          frame: frame + 1,
          totalFrames,
          progress: 8 + ((frame + 1) / totalFrames) * 90,
        });
      }
    }
    ffmpeg.stdin.end();
    await encoding;
    if (pageErrors.length) throw new Error(pageErrors.join('\n'));
    const probe = await execFile(ffmpegPath, ['-hide_banner', '-i', stagingPath, '-map', '0', '-f', 'null', '-']);
    const description = `${probe.stdout}\n${probe.stderr}`;
    const durationMatch = description.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const media = {
      duration: durationMatch ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]) : 0,
      description,
    };
    if (!/Video:\s*h264/.test(description) || !description.includes('1080x1920')) {
      throw new Error('导出视频规格校验失败');
    }
    if (!/Audio:\s*aac/.test(description)) throw new Error('导出视频缺少音轨');
    const expectedDuration = plan.duration + delaySeconds;
    if (Math.abs(media.duration - expectedDuration) > 0.08) throw new Error(`导出时长校验失败：${media.duration} / ${expectedDuration}`);
    await rename(stagingPath, outputPath);
    return { outputPath, totalFrames, media };
  } catch (error) {
    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    throw new Error(`${error.message}${ffmpegError && !error.message.includes(ffmpegError) ? `\n${ffmpegError}` : ''}`);
  } finally {
    await browser.close();
    await rm(stagingPath, { force: true });
  }
}
