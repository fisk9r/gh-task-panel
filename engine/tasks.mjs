/**
 * 任务适配器与执行器（GitHub Actions 版）
 *
 * 与 Cloudflare 版的差异：
 *  1. 去掉一切 cf 专有字段（cf.cacheTtl），纯 Node 22 fetch，Actions runner / 本地均可跑。
 *  2. 新增「密钥占位符」：配置里写 {{secrets.NAME}}，运行时从环境变量注入。
 *     这样任务配置（tasks.json）可以安全地放在公开仓库里，真实凭证只存在于 Actions Secrets。
 *
 * 设计原则（不变）：
 *  1. 只对接平台自身未设风控的公开接口 —— 站点健康检测、无签名要求的签到接口、消息推送。
 *  2. 不做任何逆向签名、设备指纹伪造或反爬绕过。接口若返回风控错误，如实上报失败，不重试硬闯。
 *  3. 每个适配器返回结构化结果：ok / message / detail，失败原因对面板可见。
 */

const RISK_HINTS = ['风控', '验证', 'captcha', 'forbidden', 'sign', '登录已失效', 'risk'];

function looksLikeRiskControl(text) {
  const t = String(text || '').toLowerCase();
  return RISK_HINTS.some((h) => t.includes(h.toLowerCase()));
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

function truncate(s, n = 400) {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return t && t.length > n ? t.slice(0, n) + '…(截断)' : t || '';
}

/* ------------------------------------------------------------------ */
/* 密钥占位符解析                                                       */
/* ------------------------------------------------------------------ */

const PLACEHOLDER = /\{\{\s*(?:secrets|env)\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * 把对象里所有字符串值中的 {{secrets.X}} / {{env.X}} 替换为环境变量 X 的值。
 * 未命中的占位符保持原样（便于面板显示"未配置"）。
 */
export function resolveSecrets(value, env = process.env) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (m, name) => {
      const v = env[name];
      return v === undefined || v === '' ? m : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveSecrets(v, env));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveSecrets(v, env);
    return out;
  }
  return value;
}

/** 输出结果前把疑似敏感值打码，防止写进公开的 data/state.json */
export function maskSecrets(value, env = process.env) {
  if (typeof value === 'string') {
    let out = value;
    for (const [k, v] of Object.entries(env)) {
      if (!v || String(v).length < 8) continue;
      if (/^(PATH|HOME|TEMP|TMP|SystemRoot|COMSPEC|PROGRAMFILES|APPDATA|LOCALAPPDATA|PWD|OLDPWD|SHELL|USER(NAME)?|HOSTNAME|GITHUB_.*|RUNNER_.*|ACTIONS_.*|INPUT_.*|NODE.*|NPM.*|SHLVL|_|PWD)$/i.test(k)) continue;
      if (out.includes(String(v))) out = out.split(String(v)).join('***');
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, env));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskSecrets(v, env);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* 内置适配器                                                          */
/* ------------------------------------------------------------------ */

const ADAPTERS = {
  /** 站点健康检测 */
  'health-check': {
    label: '站点健康检测',
    desc: '定时探测 URL 是否在线，用于监控你自己的服务/页面是否存活。',
    fields: [
      { key: 'url', label: '探测地址', type: 'text', required: true, placeholder: 'https://example.com/health' },
      { key: 'expectText', label: '响应需包含的文本（可选）', type: 'text', placeholder: '留空则只判断状态码' },
      { key: 'timeoutMs', label: '超时（毫秒，可选）', type: 'text', placeholder: '20000' },
    ],
    async run(cfg, opts) {
      if (!cfg.url) return { ok: false, message: '未配置探测地址' };
      const t0 = Date.now();
      const res = await fetchWithTimeout(cfg.url, {
        method: 'GET',
        headers: { 'User-Agent': 'gh-task-panel/1.0 (health-check)' },
        cache: 'no-store',
      }, Number(cfg.timeoutMs) || opts.timeoutMs);
      const body = await res.text().catch(() => '');
      const ms = Date.now() - t0;
      const statusOk = res.status >= 200 && res.status < 400;
      const textOk = !cfg.expectText || body.includes(cfg.expectText);
      return {
        ok: statusOk && textOk,
        message: statusOk
          ? (textOk ? '在线 ' + ms + 'ms' : '响应缺少预期文本')
          : 'HTTP ' + res.status,
        detail: { status: res.status, latencyMs: ms, bodyHead: truncate(body, 200) },
      };
    },
  },

  /** 掘金每日签到（官方 growth 接口，无签名要求） */
  'juejin-checkin': {
    label: '掘金每日签到',
    desc: '调用掘金公开的成长值签到接口。Cookie 请填 {{secrets.JUEJIN_COOKIE}}，并在仓库 Secrets 里存真实值。',
    fields: [
      { key: 'cookie', label: '掘金 Cookie', type: 'password', required: true, placeholder: '{{secrets.JUEJIN_COOKIE}}' },
    ],
    async run(cfg, opts) {
      if (!cfg.cookie) return { ok: false, message: '未配置 Cookie' };
      if (/\{\{/.test(cfg.cookie)) return { ok: false, message: 'Cookie 未注入：请检查仓库 Secrets 是否配置了对应变量' };
      const res = await fetchWithTimeout(
        'https://api.juejin.cn/growth_api/v1/check_in',
        {
          method: 'POST',
          headers: {
            'Cookie': cfg.cookie,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
            'Referer': 'https://juejin.cn/',
          },
          body: '{}',
        },
        opts.timeoutMs
      );
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(text); } catch { /* 非 JSON 响应 */ }

      if (res.status === 401 || res.status === 403 || looksLikeRiskControl(text)) {
        return { ok: false, message: 'Cookie 失效或触发风控，请重新登录获取', detail: { status: res.status, body: truncate(text) } };
      }
      if (data) {
        if (data.err_no === 0 || data.data === true) {
          return { ok: true, message: '签到成功 +' + (data.data?.incr_point ?? '?') + ' 矿石（本次）', detail: data };
        }
        if (String(data.err_msg || '').includes('已签到')) {
          return { ok: true, message: '今日已签到（跳过）', detail: data };
        }
        return { ok: false, message: data.err_msg || '接口返回异常', detail: data };
      }
      return { ok: false, message: '非预期响应', detail: { status: res.status, body: truncate(text) } };
    },
  },

  /** Server 酱推送 */
  'serverchan': {
    label: 'Server酱 消息推送',
    desc: '向 Server酱 SendKey 推送一条消息。可用 {{secrets.SENDKEY}} 引用仓库密钥。',
    fields: [
      { key: 'sendkey', label: 'SendKey', type: 'password', required: true, placeholder: '{{secrets.SENDKEY}}' },
      { key: 'title', label: '标题', type: 'text', placeholder: '定时任务通知' },
      { key: 'content', label: '内容（支持 Markdown）', type: 'textarea', placeholder: '这里是推送内容' },
    ],
    async run(cfg, opts) {
      if (!cfg.sendkey) return { ok: false, message: '未配置 SendKey' };
      if (/\{\{/.test(cfg.sendkey)) return { ok: false, message: 'SendKey 未注入：请检查仓库 Secrets' };
      const res = await fetchWithTimeout(
        'https://sctapi.ftqq.com/' + encodeURIComponent(cfg.sendkey) + '.send',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            title: cfg.title || '定时任务通知',
            desp: cfg.content || '',
          }).toString(),
        },
        opts.timeoutMs
      );
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(text); } catch { /* ignore */ }
      const ok = res.status < 400 && (!data || data.code === 0);
      return {
        ok,
        message: ok ? '推送成功' : (data?.message || '推送失败 HTTP ' + res.status),
        detail: data || { status: res.status, body: truncate(text) },
      };
    },
  },

  /**
   * 京东每日京豆签到
   * ------------------------------------------------------------------
   * 重要前提（务必读）：京东自 2023 年起对签到类接口启用 h5st 签名校验，
   * 签名需要真实浏览器环境（设备指纹 + 时间戳 + 反爬参数），纯服务端请求
   * 拿不到合法签名，会被接口拒绝。本适配器做的是「诚实尝试」：
   *   - 带上你的 Cookie 真去打一次 signBeanAct
   *   - 京东若返回签名/风控错误，如实上报，并提示改用青龙面板 + 签名库
   * 不做任何签名伪造或逆向。能成则成，不能成也不会骗你。
   */
  'jd-checkin': {
    label: '京东京豆签到',
    desc: '调用京东 signBeanAct 接口领京豆。Cookie 请填 {{secrets.JD_COOKIE}} 并在仓库 Secrets 存真实值。注意：京东已启用 h5st 签名，纯服务端请求大概率被拒，本适配器会如实上报。',
    fields: [
      { key: 'cookie', label: '京东 Cookie', type: 'password', required: true, placeholder: '{{secrets.JD_COOKIE}}' },
    ],
    async run(cfg, opts) {
      if (!cfg.cookie) return { ok: false, message: '未配置 Cookie' };
      if (/\{\{/.test(cfg.cookie)) return { ok: false, message: 'Cookie 未注入：请在仓库 Secrets 配置 JD_COOKIE' };
      const cookie = String(cfg.cookie).trim();
      const pin = (cookie.match(/pt_pin=([^;]+)/) || [])[1] || '';
      const url =
        'https://api.m.jd.com/client.action?functionId=signBeanAct&appid=ld&client=android&clientVersion=11.0.0';
      const body = JSON.stringify({ dfp: '', appid: 'ld' });
      const res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            Cookie: cookie,
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
            Referer: 'https://jdshare.m.jd.com/',
          },
          body: 'body=' + encodeURIComponent(body) + '&',
        },
        opts.timeoutMs
      );
      const text = await res.text().catch(() => '');
      let data = null;
      try { data = JSON.parse(text); } catch { /* 非 JSON */ }

      // 签名/风控拦截检测
      const blocked =
        looksLikeRiskControl(text) ||
        (data && /h5st|sign|校验|风控|滑块|验证/.test(JSON.stringify(data)));
      if (blocked) {
        return {
          ok: false,
          message:
            '被京东拦截：需要 h5st 浏览器签名，纯服务端请求无法生成。建议改用青龙面板 + 签名库（如 JDHelloWorld/jd_scripts 的签名依赖）。',
          detail: { status: res.status, body: truncate(text, 500), pin: pin ? decodeURIComponent(pin) : null },
        };
      }
      if (data) {
        const biz = (data.data && (data.data.bizMsg || data.data.msg || data.data.message)) || data.msg || data.message || '';
        if (data.code === '0' || data.success === true || /成功|已/.test(biz)) {
          return {
            ok: true,
            message: '京豆签到成功' + (pin ? '（' + decodeURIComponent(pin) + '）' : ''),
            detail: data,
          };
        }
        return { ok: false, message: biz || '接口返回异常', detail: data };
      }
      return { ok: false, message: '非预期响应', detail: { status: res.status, body: truncate(text, 300) } };
    },
  },

  /** 通用 HTTP 请求 */
  'generic-http': {
    label: '通用 HTTP 请求',
    desc: '自定义一次 HTTP 请求。适合对接你自己开发的、无鉴权风控的接口。',
    fields: [
      { key: 'url', label: '请求地址', type: 'text', required: true, placeholder: 'https://api.example.com/daily' },
      { key: 'method', label: '方法', type: 'text', placeholder: 'GET / POST，默认 GET' },
      { key: 'headers', label: '请求头（JSON 对象）', type: 'textarea', placeholder: '{"Authorization":"Bearer xxx"}' },
      { key: 'body', label: '请求体（可选）', type: 'textarea', placeholder: '留空则不发送' },
      { key: 'expectStatus', label: '期望状态码', type: 'text', placeholder: '200' },
    ],
    async run(cfg, opts) {
      if (!cfg.url) return { ok: false, message: '未配置请求地址' };
      let headers = {};
      if (cfg.headers) {
        try { headers = JSON.parse(cfg.headers); }
        catch { return { ok: false, message: '请求头不是合法 JSON' }; }
      }
      const method = (cfg.method || 'GET').toUpperCase();
      const res = await fetchWithTimeout(cfg.url, {
        method,
        headers: { 'User-Agent': 'gh-task-panel/1.0', ...headers },
        body: method === 'GET' || method === 'HEAD' ? undefined : cfg.body || '',
      }, opts.timeoutMs);
      const text = await res.text().catch(() => '');
      const expect = Number(cfg.expectStatus || 200);
      return {
        ok: res.status === expect,
        message: 'HTTP ' + res.status + (res.status === expect ? ' ✓' : '（期望 ' + expect + '）'),
        detail: { status: res.status, body: truncate(text, 300) },
      };
    },
  },
};

export function listAdapters() {
  return Object.entries(ADAPTERS).map(([type, a]) => ({
    type,
    label: a.label,
    desc: a.desc,
    fields: a.fields,
  }));
}

export function getAdapter(type) {
  return ADAPTERS[type] || null;
}

/**
 * 执行单个任务
 * @param {object} task 任务定义（含 config）
 * @param {{timeoutMs?:number, env?:object}} opts
 */
export async function runTask(task, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs || 20000);
  const started = Date.now();
  const adapter = ADAPTERS[task.type];

  if (!adapter) {
    return { ok: false, message: '未知任务类型：' + task.type, durationMs: 0 };
  }

  try {
    const cfg = resolveSecrets(task.config || {}, opts.env || process.env);
    const r = await adapter.run(cfg, { timeoutMs });
    return {
      ok: !!r.ok,
      message: r.message || (r.ok ? '成功' : '失败'),
      detail: r.detail,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      message: aborted ? '执行超时（' + timeoutMs + 'ms）' : '执行异常：' + (err && err.message ? err.message : String(err)),
      durationMs: Date.now() - started,
    };
  }
}
