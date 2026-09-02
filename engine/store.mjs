/**
 * 文件存储层
 *
 * 分工：
 *   tasks.json        —— 任务定义，唯一人工/面板编辑的源文件（不含运行结果）
 *   data/state.json   —— 运行结果汇总（面板读取）
 *   data/logs/YYYY-MM-DD.json —— 按天分片日志（Asia/Shanghai 日期）
 *
 * 这样 tasks.json 归你、data/ 归机器，Actions 每次跑完只覆盖 data/，不会把你的编辑冲掉。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const TASKS_FILE = path.join(ROOT, 'tasks.json');
export const DATA_DIR = path.join(ROOT, 'data');
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

/** 按北京时间取 YYYY-MM-DD */
export function beijingDate(ts = Date.now()) {
  return dateFmt.format(new Date(ts));
}

async function ensureDir(d) {
  await fs.mkdir(d, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function readTasks() {
  const d = await readJson(TASKS_FILE, null);
  if (!d || !Array.isArray(d.tasks)) return [];
  return d.tasks;
}

/**
 * 写回任务定义，保留文件里其他字段（如 $schema / version）。
 * 只覆盖 tasks 数组，避免面板改一次就把注释和元信息冲掉。
 */
export async function writeTasks(tasks) {
  const cur = await readJson(TASKS_FILE, {});
  const next = { ...(cur && typeof cur === 'object' ? cur : {}), tasks };
  await writeJson(TASKS_FILE, next);
}

export async function readState() {
  return await readJson(STATE_FILE, { updatedAt: null, results: {}, logs: [] });
}

export async function writeState(state) {
  await writeJson(STATE_FILE, state);
}

export async function appendLog(entry) {
  await ensureDir(LOGS_DIR);
  const file = path.join(LOGS_DIR, beijingDate(entry.at) + '.json');
  const arr = await readJson(file, []);
  arr.unshift(entry);
  await writeJson(file, arr.slice(0, 500));
}

/** 从分片日志里读最近 limit 条（跨天合并） */
export async function readLogs(limit = 120) {
  let files = [];
  try {
    files = await fs.readdir(LOGS_DIR);
  } catch {
    return [];
  }
  files = files.filter((f) => f.endsWith('.json')).sort().reverse();
  const out = [];
  for (const f of files) {
    const arr = await readJson(path.join(LOGS_DIR, f), []);
    if (Array.isArray(arr)) out.push(...arr);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** 清理超过 keepDays 天的日志分片 */
export async function pruneLogs(keepDays = 30) {
  let files = [];
  try {
    files = await fs.readdir(LOGS_DIR);
  } catch {
    return 0;
  }
  const cutoff = beijingDate(Date.now() - keepDays * 86400000);
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (f.slice(0, 10) < cutoff) {
      await fs.rm(path.join(LOGS_DIR, f), { force: true });
      removed++;
    }
  }
  return removed;
}

/** 把 data/ 同步到 docs/data/，供 Pages 静态读取 */
export async function syncToDocs(docsDir = path.join(ROOT, 'docs', 'data')) {
  const { listAdapters } = await import('./tasks.mjs');
  await ensureDir(docsDir);
  const state = await readState();
  const tasks = await readTasks();
  await writeJson(path.join(docsDir, 'state.json'), state);
  // 任务定义同步时剔除运行结果，只留结构；config 原样保留（应为占位符，非明文密钥）
  await writeJson(path.join(docsDir, 'tasks.json'), { tasks });
  await writeJson(path.join(docsDir, 'adapters.json'), { adapters: listAdapters() });
  return { state, tasks };
}
