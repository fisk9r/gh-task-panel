#!/usr/bin/env node
/**
 * 本地预览服务：把 docs/ 当成 Pages 站点跑起来，并支持一键触发任务执行。
 *
 *   node test/dev-server.mjs          默认 http://127.0.0.1:8789
 *   node test/dev-server.mjs 3000     指定端口
 *
 * 额外接口（仅本地调试用，不会进 Pages）：
 *   POST /api/refresh   重新执行全部启用任务并同步静态数据
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const PORT = Number(process.argv[2] || process.env.PORT || 8789);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function runEngine(args = []) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'engine', 'run.mjs'), '--sync-docs', ...args], {
      cwd: ROOT, env: { ...process.env, TZ: 'Asia/Shanghai' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';

  if (p === '/api/refresh' && req.method === 'POST') {
    const r = await runEngine();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: r.code === 0, out: r.out }));
    return;
  }

  // 安全：只允许访问 docs/ 内的文件
  const file = path.join(DOCS, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!file.startsWith(DOCS)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found: ' + p);
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log('  面板预览：http://127.0.0.1:' + PORT);
  console.log('  正在执行一次任务以生成数据…\n');
  const r = await runEngine();
  console.log(r.out);
  console.log('\n  就绪。浏览器打开 http://127.0.0.1:' + PORT);
  console.log('  提示：填入 GitHub PAT 后可在面板上直接增删改任务并触发运行。\n');
});
