import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [input, output, base = 'http://127.0.0.1:7100'] = process.argv.slice(2);
if (!input || !output) {
  console.error('用法：node scripts/export-cli.mjs <歌曲文件> <输出 MP4> [服务地址]');
  process.exit(2);
}
const audio = await readFile(input);
const response = await fetch(`${base}/api/jobs?name=${encodeURIComponent(path.basename(input))}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream' },
  body: audio,
});
const job = await response.json();
if (!response.ok) throw new Error(job.error || '任务创建失败');
console.log(`任务 ${job.id}：已接收 ${path.basename(input)}`);
let previous = '';
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const statusResponse = await fetch(`${base}/api/jobs/${job.id}`);
  const status = await statusResponse.json();
  if (!statusResponse.ok) throw new Error(status.error || '读取导出进度失败');
  const line = `${status.phase} ${Math.round(status.progress)}% ${status.frame || 0}/${status.totalFrames || 0}`;
  if (line !== previous) {
    console.log(line);
    previous = line;
  }
  if (status.phase === 'error') throw new Error(status.error);
  if (status.phase === 'done') break;
}
const videoResponse = await fetch(`${base}/api/jobs/${job.id}/video`);
if (!videoResponse.ok) throw new Error('视频下载失败');
await mkdir(path.dirname(path.resolve(output)), { recursive: true });
await writeFile(path.resolve(output), Buffer.from(await videoResponse.arrayBuffer()));
console.log(path.resolve(output));
