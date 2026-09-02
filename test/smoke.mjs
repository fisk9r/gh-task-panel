import { spawn } from 'node:child_process';
/**
 * 冒烟测试：在临时工作区里跑完整条链路（不影响仓库真实 data/ 与 tasks.json）
 *
 *   node test/smoke.mjs
 *
 * 覆盖：占位符注入、健康检测成功/失败、通用 HTTP、状态落盘、日志分片、
 *       密钥打码、同步到 docs/data、面板 HTML 完整性。
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 起两个本地站点当被测目标 ---------- */
const targets = [
  { port: 0, handler: (req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK-ALIVE'); } },
  { port: 0, handler: (req, res) => { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('boom'); } },
];
const servers = [];
for (const t of targets) {
  const s = http.createServer(t.handler);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  t.port = s.address().port;
  servers.push(s);
}
const [OK_URL, BAD_URL] = targets.map((t) => 'http://127.0.0.1:' + t.port + '/');

/* ---------- 搭临时工作区 ---------- */
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ghtp-'));
await fs.mkdir(path.join(tmp, 'engine'), { recursive: true });
for (const f of ['tasks.mjs', 'store.mjs', 'run.mjs']) {
  await fs.copyFile(path.join(PROJECT, 'engine', f), path.join(tmp, 'engine', f));
}

const testTasks = [
  { id: 't_ok', name: '健康检测-存活', type: 'health-check', enabled: true, config: { url: OK_URL, expectText: 'OK-ALIVE' } },
  { id: 't_bad', name: '健康检测-挂了', type: 'health-check', enabled: true, config: { url: BAD_URL } },
  { id: 't_text', name: '健康检测-文本不符', type: 'health-check', enabled: true, config: { url: OK_URL, expectText: 'NEVER-MATCH' } },
  { id: 't_off', name: '未启用任务', type: 'health-check', enabled: false, config: { url: OK_URL } },
  { id: 't_secret', name: '密钥占位符', type: 'generic-http', enabled: true, config: { url: OK_URL, method: 'GET', expectStatus: '200', headers: '{"X-Token":"{{secrets.MY_TOKEN}}"}' } },
  { id: 't_missing', name: '密钥未注入', type: 'juejin-checkin', enabled: true, config: { cookie: '{{secrets.NOPE_COOKIE}}' } },
];
await fs.writeFile(path.join(tmp, 'tasks.json'), JSON.stringify({ version: 1, tasks: testTasks }, null, 2));

const run = (args = [], env = {}) => new Promise((resolve) => {
  
  const p = spawn(process.execPath, [path.join(tmp, 'engine', 'run.mjs'), ...args], {
    cwd: tmp,
    env: { ...process.env, MY_TOKEN: 'SUPER_SECRET_VALUE_12345', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('close', (code) => resolve({ code, out }));
});

console.log('\n=== 1. 引擎执行 ===');
const r1 = await run(['--sync-docs']);
check('退出码为 0（单任务失败不标红工作流）', r1.code === 0, 'code=' + r1.code);
check('输出包含成功标记', r1.out.includes('✓ 健康检测-存活'), r1.out.slice(0, 300));
check('输出包含失败标记', r1.out.includes('✗ 健康检测-挂了'));
check('启用了 5 个任务（未启用的被跳过）', /共 5 个任务/.test(r1.out), r1.out.split('\n').slice(-3).join(' | '));

const state = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'state.json'), 'utf8'));
check('state.json 已生成且有 updatedAt', !!state.updatedAt);
check('存活任务记为成功', state.results.t_ok.ok === true, JSON.stringify(state.results.t_ok));
check('挂掉的任务记为失败', state.results.t_bad.ok === false);
check('文本不符记为失败', state.results.t_text.ok === false && /缺少预期文本|文本/.test(state.results.t_text.message));
check('未启用任务未被执行', !state.results.t_off);
check('密钥占位符已注入并生效', state.results.t_secret.ok === true, JSON.stringify(state.results.t_secret));
check('未注入的密钥如实报失败', state.results.t_missing.ok === false && /未注入/.test(state.results.t_missing.message));

console.log('\n=== 2. 敏感值打码 ===');
const stateRaw = await fs.readFile(path.join(tmp, 'data', 'state.json'), 'utf8');
check('真实密钥值未写入 state.json', !stateRaw.includes('SUPER_SECRET_VALUE_12345'));
const logFiles = await fs.readdir(path.join(tmp, 'data', 'logs'));
check('日志按天分片生成', logFiles.length === 1 && /^\d{4}-\d{2}-\d{2}\.json$/.test(logFiles[0]), logFiles.join(','));
const logs = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'logs', logFiles[0]), 'utf8'));
check('日志条数为 5', logs.length === 5, 'len=' + logs.length);
check('日志按时间倒序', logs[0].at >= logs[logs.length - 1].at);

console.log('\n=== 3. 定向执行与开关 ===');
const r2 = await run(['--only=t_bad']);
check('--only 只跑指定任务', r2.out.includes('共 1 个任务'), r2.out.split('\n').slice(-2).join(' | '));
const r3 = await run(['--all']);
check('--all 忽略启用开关跑全部 6 个', /共 6 个任务/.test(r3.out), r3.out.split('\n').slice(-2).join(' | '));
const r4 = await run(['--dry']);
check('--dry 不发请求只校验', /共 5 个任务/.test(r4.out), r4.out.split('\n').slice(-2).join(' | '));
check('--dry 检出未注入的密钥', r4.out.includes('配置未注入：cookie'));
const r5 = await run(['--strict']);
check('--strict 在有失败时返回 1', r5.code === 1, 'code=' + r5.code);

console.log('\n=== 4. 累计统计 ===');
const state2 = JSON.parse(await fs.readFile(path.join(tmp, 'data', 'state.json'), 'utf8'));
check('存活任务累计运行 3 次（首轮+all+dry）', state2.results.t_ok.runCount === 3, 'n=' + state2.results.t_ok.runCount);
check('成功次数单独累计', state2.results.t_ok.okCount === 3 && state2.results.t_bad.okCount === 0,
  JSON.stringify({ ok: state2.results.t_ok.okCount, bad: state2.results.t_bad.okCount }));

console.log('\n=== 5. 同步到静态目录 ===');
await fs.mkdir(path.join(tmp, 'docs'), { recursive: true });
const { syncToDocs } = await import(pathToFileURL(path.join(tmp, 'engine', 'store.mjs')).href);
await syncToDocs(path.join(tmp, 'docs', 'data'));
const docsFiles = await fs.readdir(path.join(tmp, 'docs', 'data'));
check('生成 state.json / tasks.json / adapters.json',
  ['state.json', 'tasks.json', 'adapters.json'].every((f) => docsFiles.includes(f)), docsFiles.join(','));
const adapters = JSON.parse(await fs.readFile(path.join(tmp, 'docs', 'data', 'adapters.json'), 'utf8'));
check('适配器清单含 5 种类型', adapters.adapters.length === 5, 'n=' + adapters.adapters.length);
check('适配器字段声明完整', adapters.adapters.every((a) => a.fields.length > 0 && a.label && a.desc));
const docsState = await fs.readFile(path.join(tmp, 'docs', 'data', 'state.json'), 'utf8');
check('静态产物同样不含明文密钥', !docsState.includes('SUPER_SECRET_VALUE_12345'));

console.log('\n=== 6. 工作流与面板文件 ===');
const yml = await fs.readFile(path.join(PROJECT, '.github', 'workflows', 'daily.yml'), 'utf8');
check('daily.yml 含两个 cron', (yml.match(/cron:/g) || []).length === 2);
check('daily.yml 支持手动触发', yml.includes('workflow_dispatch'));
check('daily.yml 注入了 JUEJIN_COOKIE 密钥', yml.includes('JUEJIN_COOKIE: ${{ secrets.JUEJIN_COOKIE }}'));
check('daily.yml 有 contents: write 权限（才能提交结果）', yml.includes('contents: write'));
const pyl = await fs.readFile(path.join(PROJECT, '.github', 'workflows', 'pages.yml'), 'utf8');
check('pages.yml 有 pages: write 权限', pyl.includes('pages: write'));
check('pages.yml 上传 docs 目录', pyl.includes('path: docs'));

const html = await fs.readFile(path.join(PROJECT, 'docs', 'index.html'), 'utf8');
check('面板含控制台标题', html.includes('定时任务控制台'));
check('面板含 PAT 连接入口', html.includes('id="pat"'));
check('面板含新建/运行/编辑/删除动作', ['data-act="run"', 'data-act="edit"', 'data-act="del"', 'id="btnNew"'].every((s) => html.includes(s)));
check('面板调用 workflow_dispatch', html.includes('/actions/workflows/daily.yml/dispatches'));
check('面板写回 tasks.json 用 Contents API', html.includes('/contents/tasks.json'));
check('面板无外部 CDN 依赖（离线可用）', !/<script\s+src=|<link[^>]+href=["']https?:/i.test(html));

/* ---------- 收尾 ---------- */
for (const s of servers) s.close();
await fs.rm(tmp, { recursive: true, force: true });

console.log('\n————————————————————————————');
console.log('结果：PASS ' + pass + ' / FAIL ' + fail);
process.exit(fail ? 1 : 0);
