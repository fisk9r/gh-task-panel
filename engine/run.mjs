#!/usr/bin/env node
/**
 * 任务执行入口（GitHub Actions / 本地通用）
 *
 *   node engine/run.mjs                 执行全部启用任务
 *   node engine/run.mjs --only=t_xxx    只执行指定 id
 *   node engine/run.mjs --all           忽略 enabled 开关，全部执行
 *   node engine/run.mjs --dry           只校验配置不实际请求
 *
 * 退出码：默认恒为 0（单个任务失败不应把 workflow 标红，失败明细在日志与面板里看）。
 * 需要严格模式时加 --strict，有任何任务失败则 exit 1。
 */

import { runTask, resolveSecrets } from './tasks.mjs';
import {
  readTasks, readState, writeState, appendLog, readLogs, pruneLogs, syncToDocs,
} from './store.mjs';

const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : null;
};
const has = (name) => args.includes('--' + name);

async function main() {
  const only = arg('only');
  const runAll = has('all');
  const dry = has('dry');
  const strict = has('strict');
  const syncDocs = has('sync-docs') || process.env.SYNC_DOCS === '1';

  let tasks = await readTasks();
  if (only) tasks = tasks.filter((t) => t.id === only);
  else if (!runAll) tasks = tasks.filter((t) => t.enabled !== false);

  if (!tasks.length) {
    console.log(only ? '未找到任务：' + only : '没有启用的任务，跳过。');
    if (syncDocs) await syncToDocs();
    return 0;
  }

  const state = await readState();
  state.results = state.results || {};

  const entries = [];
  for (const t of tasks) {
    if (dry) {
      // 只解析占位符并报告缺失项，不发请求
      const cfg = resolveSecrets(t.config || {});
      const missing = Object.entries(cfg)
        .filter(([, v]) => typeof v === 'string' && /\{\{\s*(?:secrets|env)\./.test(v))
        .map(([k]) => k);
      const msg = missing.length ? '配置未注入：' + missing.join(', ') : '配置校验通过（dry-run）';
      entries.push({
        at: Date.now(), taskId: t.id, taskName: t.name, type: t.type,
        ok: missing.length === 0,
        message: msg,
        durationMs: 0,
      });
      console.log((missing.length === 0 ? '  ✓ ' : '  ✗ ') + t.name + ' [' + t.type + '] ' + msg);
      continue;
    }

    const r = await runTask(t);
    const at = Date.now();
    const entry = {
      at,
      taskId: t.id,
      taskName: t.name,
      type: t.type,
      ok: r.ok,
      message: r.message,
      durationMs: r.durationMs,
    };
    entries.push(entry);
    await appendLog(entry);

    const prev = state.results[t.id] || { runCount: 0, okCount: 0 };
    state.results[t.id] = {
      at,
      ok: r.ok,
      message: r.message,
      durationMs: r.durationMs,
      runCount: (prev.runCount || 0) + 1,
      okCount: (prev.okCount || 0) + (r.ok ? 1 : 0),
    };

    console.log(
      (r.ok ? '  ✓ ' : '  ✗ ') + t.name +
      ' [' + t.type + '] ' + r.message +
      ' (' + r.durationMs + 'ms)'
    );
  }

  state.updatedAt = Date.now();
  state.logs = await readLogs(120);
  await writeState(state);

  const removed = await pruneLogs(30);
  if (removed) console.log('  已清理过期日志分片：' + removed + ' 个');

  if (syncDocs) await syncToDocs();

  const ok = entries.filter((e) => e.ok).length;
  const fail = entries.length - ok;
  console.log('————————————————————————————');
  console.log('共 ' + entries.length + ' 个任务：成功 ' + ok + '，失败 ' + fail);

  // 写入 GitHub Actions 步骤摘要
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    const rows = entries.map((e) =>
      '| ' + (e.ok ? '✅' : '❌') + ' | ' + e.taskName + ' | `' + e.type + '` | ' +
      String(e.message).replace(/\|/g, '\\|') + ' | ' + e.durationMs + 'ms |'
    ).join('\n');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      '## 定时任务执行结果\n\n| 状态 | 任务 | 类型 | 结果 | 耗时 |\n|---|---|---|---|---|\n' + rows + '\n',
      'utf8'
    );
  }

  return strict && fail > 0 ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('执行器崩溃：', e);
  process.exit(2);
});
