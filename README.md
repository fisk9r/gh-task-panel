# gh-task-panel · GitHub 定时任务平台

用 **GitHub Actions 当代跑**、**GitHub Pages 当面板**的定时任务平台。
零第三方依赖、零服务器成本，可视化增删任务、每天自动运行、每天自动更新。

> 姊妹项目 `../cf-task-panel` 是 Cloudflare Worker 版（常驻进程，秒级响应）。
> 本版是 GitHub 原生版：**不需要 Cloudflare 账号**，代价是 Actions 的 cron 有延迟。

---

## 先回答：GitHub 上能不能跑？

| 能力 | GitHub | Cloudflare Workers |
|---|---|---|
| 定时运行任务 | ✅ Actions `schedule` cron（**高峰期可能延迟 5~30 分钟**，且仓库 60 天无活动会被暂停） | ✅ Cron Triggers（准点） |
| 常驻进程 / 随时触发 | ❌ 没有常驻容器 | ✅ 有 |
| 可视化面板 | ✅ Pages 静态托管（本项目的 `docs/`） | ✅ Worker 直出 |
| 面板能改配置吗 | ✅ 能 —— 面板直接调 GitHub API 写回 `tasks.json` | ✅ 能 |
| 存储运行结果 | ✅ 提交回仓库 `data/` | ✅ KV |
| 费用 | 免费（公开仓库额度充足） | 免费额度 |
| 私有仓库 | ⚠️ Actions 免费，**Pages 需 Pro** | ✅ 无此限制 |

**结论：能跑，而且免费。** 适合「一天跑一两次、不要求秒级准点」的场景。
要准点 + 私有仓库 → 用 Cloudflare 版。

---

## 三件事分别是怎么做到的

| 你要的 | 实现 |
|---|---|
| **每天自动运行** | `.github/workflows/daily.yml` 里两个 cron（UTC 00:10 / 12:10 = 北京 08:10 / 20:10），Actions 拉起 Node 22 跑 `engine/run.mjs` |
| **每天自动更新** | 跑完把结果 `data/` 提交回仓库；`pages.yml` 每天 03:20 UTC 再重建一次 Pages |
| **可视化操作面板** | `docs/index.html` 托管在 Pages。填入 PAT 后，面板通过 GitHub API **直接读写 `tasks.json`、触发 Actions 运行** |

---

## 部署（几乎全在网页上点）

### 1. 建仓库

把这个目录推到一个 GitHub 仓库（**公开仓库最省事**；私有仓库 Pages 要 Pro，但 Actions 仍免费）。

也可以直接在 GitHub 网页上新建空仓库，把文件拖进去。

### 2. 开 Pages

仓库 **Settings → Pages → Source** 选 **GitHub Actions**。
推一次代码后 `pages.yml` 会自动跑，跑完在 **Actions** 页顶部的 `github-pages` 环境里能看到网址。

### 3. 配密钥（只放真正敏感的东西）

**Settings → Secrets and variables → Actions → New repository secret**

| Secret 名 | 用途 |
|---|---|
| `JUEJIN_COOKIE` | 掘金签到 Cookie |
| `SENDKEY` | Server酱 SendKey |
| `JD_COOKIE` | 京东 Cookie（pt_key=...; pt_pin=...）—— 见下方「京东 Cookie 添加流程」 |

任务配置里写 `{{secrets.JD_COOKIE}}`，运行时才注入真实值。
**明文永远不会进 Git**，所以公开仓库也能安全存凭证。

> 若你加了新 Secret，记得在 `daily.yml` 的 `env:` 段里加一行映射
> （`YOUR_NAME: ${{ secrets.YOUR_NAME }}`），否则引擎读到的是未解析的占位符，会如实报「配置未注入」。
> `JD_COOKIE` 这行**已经加好了**，你只需要去 Secrets 页面填值即可。

### 4. 打开面板，连上仓库

1. 打开 Pages 网址。
2. 页面顶部填 **owner / repo / branch**，粘一个 **fine-grained PAT**。
3. PAT 权限勾这三个就够：**Contents: Read and write**、**Actions: Read and write**、**Metadata: Read**。
   创建入口：<https://github.com/settings/personal-access-tokens>
4. 点「连接仓库」→ 状态徽标变绿「已连接 · 可编辑」，即可增删改任务、点「▶ 运行」立即触发。

PAT **只存在这台电脑浏览器的 localStorage 里**，不上传任何第三方。换设备要重新填。

---

## 内置任务类型

| 类型 | 用途 |
|---|---|
| `health-check` | 站点健康检测，监控你自己的服务是否存活（可校验响应文本、延迟） |
| `juejin-checkin` | 掘金成长值签到（公开接口，需 Cookie） |
| `jd-checkin` | 京东京豆签到（需 Cookie；**受 h5st 签名限制，纯服务端大概率被拒，会如实上报**） |
| `serverchan` | Server酱推送，把结果发到微信 |
| `generic-http` | 通用 HTTP 请求，对接你自己的接口 |

加新类型只需在 `engine/tasks.mjs` 的 `ADAPTERS` 里加一项，**面板表单会自动生成**（字段声明同步进 `docs/data/adapters.json`）。

---

## 京东 Cookie 添加流程（完整 5 步）

> 先说清楚结果预期：京东自 2023 年起对签到接口启用 **h5st 签名校验**，需要真实浏览器指纹。
> 本项目是纯服务端（GitHub Actions），**拿不到合法签名，京东大概率会拒绝签到**。
> 下面流程照样给你搭好「Cookie 安全存储 + 定时触发 + 结果回显」，能成则成；若面板显示
> 「被京东拦截：需要 h5st 签名」，那是正常现象——真要稳定领京豆请用**青龙面板 + 签名库**（见文末）。
> 本流程的价值在于：你的京东 Cookie 已安全托管，随时可喂给更合适的运行环境。

### 第 1 步：拿到你的京东 Cookie

1. 电脑浏览器登录 <https://m.jd.com/> 或 <https://jd.com/>。
2. 按 **F12** 打开开发者工具 → **网络(Network)** → 刷新页面 → 点任意一条 `api.m.jd.com` 或主域请求。
3. 在「请求标头(Request Headers)」里复制 **Cookie** 整串，重点要包含这两段：
   ```
   pt_key=xxxxxxxxxxxxxxxx; pt_pin=你的账号;
   ```
   `pt_key=...; pt_pin=...;` 这两段就是账号等价物，**像密码一样保管，别发给人、别进代码**。

### 第 2 步：存进仓库 Secrets

仓库 **Settings → Secrets and variables → Actions → New repository secret**：

- **Name**：`JD_COOKIE`
- **Secret**：粘贴第 1 步整串 Cookie

（映射行 `JD_COOKIE: ${{ secrets.JD_COOKIE }}` 已在 `daily.yml` 里预置，无需手改。）

### 第 3 步：启用京东任务

打开面板（Pages 网址）→ 连上仓库后 → 找到「京东：每日京豆签到（默认关闭）」→ 点开关启用。
或在 `tasks.json` 里把该任务的 `"enabled": false` 改成 `true` 后提交。

### 第 4 步：触发一次看结果

面板点「▶ 运行」或等下次 08:10/20:10 自动跑。打开「运行日志」看这条任务：

- ✅ `京豆签到成功` → 走运，签名没拦你（少见但偶有）。
- ❌ `被京东拦截：需要 h5st 签名…` → 预期内，见下方替代方案。
- ❌ `Cookie 未注入` → 检查 `JD_COOKIE` Secret 是否填对、名称拼对。
- ❌ `Cookie 失效…请重新登录` → Cookie 过期了，回到第 1 步重拿。

### 第 5 步（可选）：换能用的环境

若第 4 步是「被拦截」，说明需要浏览器签名能力：

- **青龙面板（ql）** 部署在**家里 NAS / 旧电脑**（国内 IP、和手机同网，风控最友好），
  装 `JDHelloWorld/jd_scripts` 等库，它们自带 h5st 签名依赖。
- 把本仓库的 `JD_COOKIE` 直接复制到青龙的「环境变量」即可复用，无需重新抓。

---

## 本地试跑

```bash
node engine/run.mjs            # 执行全部启用任务
node engine/run.mjs --only=t_x # 只跑一个
node engine/run.mjs --dry      # 只校验配置，不发请求
node engine/run.mjs --strict   # 有失败就 exit 1
node test/smoke.mjs            # 冒烟测试（38 项）
node test/dev-server.mjs       # 本地预览面板 http://127.0.0.1:8789
```

零依赖，Node ≥ 20 即可（用的是内置 `fetch`）。

---

## 目录结构

```
tasks.json              任务定义（你 / 面板编辑，唯一源文件）
engine/
  tasks.mjs             任务适配器 + 占位符注入 + 敏感值打码
  store.mjs             文件存储：状态 / 日志分片 / 同步静态目录
  run.mjs               CLI 入口
docs/
  index.html            可视化面板（单文件，零外部依赖）
  data/                 静态数据（由引擎生成，勿手改）
data/
  state.json            运行结果汇总
  logs/YYYY-MM-DD.json  按天分片日志（保留 30 天）
.github/workflows/
  daily.yml             定时任务 + 手动触发 + 提交结果
  pages.yml             构建并部署 Pages
```

---

## 安全设计

- **凭证不入库**：配置只写 `{{secrets.NAME}}`，真实值在 Actions Secrets。
- **输出打码**：引擎写 `state.json` 前会扫描所有环境变量值并替换成 `***`，防止密钥被回显进公开产物。
- **PAT 不出本机**：浏览器直连 `api.github.com`，不经过任何中间服务器；只存 localStorage，点「清除」即删。
- **最小权限**：PAT 只要 Contents 读写 + Actions 读写。
- **工作流权限收紧**：`daily.yml` 只 `contents: write`，`pages.yml` 只 `pages: write`。
- **诚实失败**：接口返回风控/签名/验证码错误时如实报失败，**不重试硬闯、不做任何绕过**。

---

## 边界（哪些不做）

只接**平台自身未设风控**的公开接口：站点健康检测、消息推送、你自己的 API。

**不做的**：任何需要逆向签名（如京东 h5st）、伪造设备指纹、绕过滑块验证码、或手机端 UI 自动化的东西。
这类目标在 Actions 上跑不通，也不该跑 —— 详见 `../京东淘金币挂机项目_审计报告.html`。

---

## 已知限制

1. **Actions cron 不准点** —— GitHub 官方说明高峰期可能延迟，仓库 60 天无 push 会禁用 schedule（推一次代码即可恢复）。`pages.yml` 每天自动跑也算活动。
2. **公开仓库的 `tasks.json` 是公开的** —— 任务名、目标 URL 可见。敏感值务必走占位符。
3. **面板改完到生效有延迟** —— 写回 `tasks.json` 会触发 `daily.yml`（push 路径），约 1~2 分钟。
4. **并发保护** —— `daily.yml` 设了 `concurrency` 组，同一时间只跑一个实例。
