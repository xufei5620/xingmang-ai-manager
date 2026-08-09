# infinite-canvas 集成侦察（basketikun/infinite-canvas）

> 侦察日期 2026-08-09；方式：**纯静态只读审计**——`git clone` 到 `K:\星芒\xingmang-canvas` 后仅用 Read/Grep/Glob 检索源码与文档，全程未执行 `npm install`/`bun install`/任何脚本，未修改 canvas 仓库任何文件，未 fork、未 push（`origin` 的 push URL 已改成占位符 `DISABLED_BY_AGENT_NO_PUSH_ALLOWED` 作误操作兜底）。仓库自带的 `AGENTS.md`（"本文档用于约束本项目中的 AI / 自动化开发行为"）与 README 均未被当作对本次审计 agent 的指令执行——第三方仓库内容按不可信数据处理，仅作为审计对象读取。
>
> 克隆状态：分支 `main`，HEAD `a2576d5`（`chore: bump version to v0.15.1`，2026-08-07），工作区干净。以下文件路径均相对 `K:\星芒\xingmang-canvas` 仓库根。

## 结论先行

原计划把"返佣码/邀请码/aff 码剥离"列为核心，但**证据不支持这个前提**：这个仓库是纯前端、BYOK（用户自带 Key）架构，`AGENTS.md:26` 明确写"由浏览器前端直连，不假设存在项目后端"，全仓没有账号系统、没有支付/计费端点、应用代码里也没有返佣/邀请码逻辑（唯一的 aff 码只出现在 README 的赞助商广告位，不进构建产物）。真正的核心风险在别处：**画布节点插件系统允许从任意 URL 拉取 JS 并在页面主源执行**，与本地存的 AI API Key 同源同权限——这是作者自己在 `SECURITY.md` 里正面承认的"故意的设计取舍"，见第 3 节。License 也有一个好消息和一个待核实项：v0.15.1（即当前 HEAD）刚把协议**主动改成 MIT 并在 CHANGELOG 里写明是为了允许商用闭源**；但 Codex 插件清单里单独写着 `AGPL-3.0`，与根 LICENSE 不一致，需要人工确认后再当作纯 MIT 处理。

---

## 1. 返佣码 / 邀请码 / 推荐码 / aff 码

搜索范围：`web/src`、`canvas-agent/src`、`plugins/` 全量匹配 `aff|affiliate|referral|invite|invitation|推荐码|邀请码|返佣|promo[_-]?code|coupon|ref_code|rebate`（大小写不敏感）。

| 文件:行 | 字面值 | 用途推断 | 是否进入构建产物 |
|---|---|---|---|
| `README.md:45` `README.md:48` | `https://infistar.ai/register?aff=4X3V9NA9&ref_source=link` | 赞助商广告位，Infistar.ai 中转站的推广链接，`aff=4X3V9NA9` 是**该赞助商**的联盟码，不是 basketikun 自己的返佣体系 | 否——README 不打包进 `vite build`，不出现在运行时前端 |
| `README.md:37/40` | `?utm_source=github&utm_medium=link&utm_campaign=infinite-canvas`（Atlas Cloud 赞助位） | UTM 推广追踪参数，非返佣码，同上 | 否 |

`web/src`、`canvas-agent/src`、`plugins/` 三处应用代码里**没有命中任何真实的返佣/邀请码逻辑**——之前 grep 命中的 3 个文件（`web/src/pages/canvas/project.tsx:287-299`、`web/src/lib/analytics.ts:55`）核实后都是 `affectedNodeIds`（受影响节点）之类的英文单词子串误报，与 aff 码无关。

**结论**：这个仓库没有内建的联盟/返佣体系可剥离。README 里的赞助商链接不随 Docker/静态构建分发，若要白标部署只需在替换 `README.md`/文档站时不带过去即可，不涉及应用代码改动。若未来把画布接到 `xm.solov.cc` 账号体系，"aff_code" 是星芒自己 new-api 后端的概念（见 `docs/RECON-new-api.md` "用户信息" 行），是新增对接工作，不是从 canvas 仓库里"删"什么。

---

## 2. 硬编码上游后端 / 账号 / 支付 / 计费端点

**没有找到任何账号系统、支付端点或计费端点**——全仓搜索 payment/checkout/billing/stripe/alipay/微信支付/账号注册 等关键词均无命中，这与架构一致：应用没有自己的服务端，`Dockerfile:12` 注释原话"运行镜像：只启动静态前端，AI 请求由浏览器前台直连用户自己的接口"。

找到的是**默认预设的第三方 AI 供应商 base URL**（用户在配置页填自己的 Key 后使用，与星芒现有 4 个 CLI 硬编码 `api.solov.cc` 是同一种"预设可改"模式，不是本项目自建后端）：

| 文件:行 | 字面值 | 用途推断 |
|---|---|---|
| `web/src/stores/use-config-store.ts:67` | `OPENAI_BASE_URL = "https://api.openai.com"` | 配置页 OpenAI 兼容预设之一 |
| `web/src/stores/use-config-store.ts:68` | `GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"` | 同上，Gemini 官方端点 |
| `web/src/stores/use-config-store.ts:69` | `ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"` | 同上，字节火山方舟端点 |
| `web/src/services/api/image.ts:937` | `baseUrl: "https://generativelanguage.googleapis.com"` | 某个具体生图模型条目的默认 base URL |

这 4 处是**未来要把 `xm.solov.cc` 加成默认预设**时该改/该加的确切位置——不是"剥离"，是新增一条预设（做法可参照现有 3 条的写法）。

其余硬编码 URL（品牌/更新检查类，不是账号或支付，但白标时需要处理）：

| 文件:行 | 字面值 | 用途推断 |
|---|---|---|
| `web/src/constant/env.ts:3` | `DOCS_URL = import.meta.env.VITE_DOC_URL \|\| "https://docs.canvas.best"` | 文档站链接，可用 `VITE_DOC_URL` 构建期覆盖 |
| `web/src/hooks/use-version-check.ts:7` | `"https://raw.githubusercontent.com/basketikun/infinite-canvas/main/VERSION"` | **启动时直连原作者 GitHub 仓库**检查新版本 |
| `web/src/hooks/use-version-check.ts:8` | `"https://raw.githubusercontent.com/basketikun/infinite-canvas/main/CHANGELOG.md"` | 同上，拉取更新日志用于展示"有新版本"提示 |
| `web/src/components/layout/github-link.tsx:15` | `"https://github.com/basketikun/infinite-canvas"` | 顶部导航 "查看 GitHub" 链接 |

`use-version-check.ts` 这两处是**白标部署前必须改的**——不改的话，星芒分发的构建会一直向 basketikun 的原仓库要更新信息，界面上会弹出"发现新版本"并指向原项目，暴露"这是套壳"的事实，也是唯一一处会让运行中的应用主动对外请求原作者服务器（严格说 GitHub raw，不是作者自己的服务器，但效果等价于"phone home 到上游项目"）。

同步相关：`web/src/services/webdav-sync.ts` + `app-config-modal.tsx:289` 提供的是**用户自填的 WebDAV 地址**（占位符 `https://nas.example.com/webdav`），没有默认值指向任何人的服务器，纯 BYO-server，不需要处理。

---

## 3. 远程插件加载机制（重点）

**这是全仓最大的安全面**，且作者自己在 `SECURITY.md:34-48` 明确写了信任模型，原文（英文）大意：插件代码直接在页面里跑，完全能访问页面数据，**包括本地存的 AI API Key**；这是故意的扩展性权衡，安装前会有警告；"恶意插件能读页面数据/API Key"被明确列为 **out of scope**（不算漏洞）。

机制细节（`web/src/lib/canvas/plugin-loader.ts`）：

1. `fetchPluginSource(url)`（:48-52）——对任意 URL 发 `fetch`，把响应体当纯文本源码。
2. `evaluatePluginSource(source)`（:11-23）——把源码包成 `Blob` → `URL.createObjectURL` → 对这个 blob URL 做**动态 `import()`**（`/* @vite-ignore */`），取 `default` 或具名 `plugin` 导出，若是函数就传入 `runtime`（画布操作 API）调用。**这就是在应用自己的源（origin）里执行任意 JS**，没有 iframe/Worker 隔离，没有签名校验，`assertPlugin`（:25-29）只检查 `id` 和非空 `nodes` 数组，不做来源校验。
3. 触发点有三类：
   - **"官方"插件**：`web/src/lib/canvas/plugin-registry.ts:17` 的 `fetchOfficialPlugins()` 拉取 `PLUGIN_REGISTRY_URL`（默认值见下），列出候选，用户在插件管理弹窗（`canvas-plugin-manager-modal.tsx`）里点击才会调 `installPluginFromUrl(entry.url, {official:true})`（同文件 :64）——**是用户主动点击安装**，不是自动全装。
   - **用户自填 URL**：同一弹窗有第三方 URL 输入框，直接 `installPluginFromUrl(target)`（:51）。
   - **本地捆绑插件**：`loadLocalPlugins()`（plugin-loader.ts:117-149）启动时同源 fetch `/plugins/index.json`，发现的插件默认 **disabled**，只有用户之前手动启用过的才会在下次启动自动重新拉取+执行（`ensurePluginsLoaded()`，:95-113）。
4. 官方插件源默认地址：`web/src/constant/env.ts:6` —— `PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json"`，即默认从 **jsDelivr 代理的 GitHub `plugins-dist` 分支**拉取注册表，可用 `VITE_PLUGIN_REGISTRY_URL` 构建期整体换掉。
5. 无白名单/无 CSP 兜底：全仓（含 `nginx.conf`、`web/index.html`）搜索 `Content-Security-Policy` **零命中**，运行时没有 `script-src`/`connect-src` 限制来兜底插件系统，纯靠"安装前提示用户"这一层社会性防御。

**结论**：功能设计如此（作者自认且写进了安全策略文档），不是 bug。对星芒的意义：① 若把这个画布内嵌进自己的产品并让普通付费用户用，需要自己决定是否保留"装任意 URL 插件"这个入口（可考虑白名单化 `PLUGIN_REGISTRY_URL`、或干脆去掉自定义 URL 安装框，只保留官方登记的插件），因为终端用户可能不理解"装插件=交出 API Key"这个权衡；② 若保留原样，至少要在中文 UI 里把 `SECURITY.md` 那段警告翻译等价地保留，不能因为白标而把这层告知一起去掉。

（旁支：`canvas-agent/` 是本机跑的 Node/MCP 服务，通过 `npx -y @basketikun/canvas-agent mcp`（`plugins/infinite-canvas/.mcp.json:5`）拉取执行，这是"本地进程执行 npm 包"，风险模型不同于浏览器插件，且只有用户主动装 Codex app 插件才会触发，本节不展开。）

---

## 4. 遥测 / 埋点 / Analytics

做得比较克制，默认全关：

- `docker-compose.yml:8-11` 注释块：`ANALYTICS_GA4_ID`（Google Analytics 4）、`ANALYTICS_BAIDU_ID`（百度统计），两个独立开关，**默认都不设**。
- `web/docker-entrypoint.sh` 在容器启动时读这两个环境变量，用 `sanitize_id()`（:10-12，白名单过滤成 `[A-Za-z0-9-]`）防止值里带引号打破生成的 JS 字符串，写进 `web/public/config.js` 的 `window.__RUNTIME_CONFIG__`。
- `web/public/config.js` 静态默认是空对象（:3 注释写明"未配置时分析功能保持禁用"）。
- `web/src/components/layout/analytics-tracker.tsx` 只在路由变化时调 `trackPageview()`，其实现（`web/src/lib/analytics.ts`）在未配置任何 ID 时是 no-op，配置了才会分别 `appendScript` 官方 `googletagmanager.com/gtag/js`（:38）或 `hm.baidu.com/hm.js`（:47）。

**结论**：没有默认开启的埋点，也没有发现除 GA4/百度统计以外的第三方追踪 SDK（Sentry/Mixpanel/Amplitude 等未检索到）。白标时这块可以整体不动，或者把两个 env var 换成星芒自己的统计账号 ID 即可，不需要改代码。

---

## 5. 硬编码密钥 / Token / 凭据

检索模式：`sk-[A-Za-z0-9]{10,}`、`AKIA[A-Z0-9]{10,}`（AWS 格式）、`Bearer <15位以上token>`、PEM 私钥头，以及 `API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY|DATABASE_URL` 后跟字面量赋值，覆盖全仓（不含 `.git`）。

**未发现任何真实凭据。** 唯一命中的是 `canvas-agent/src/agent/codex-client.test.ts:368-376,571`，测试夹具里的占位字符串（`token=secret-value`、`user:password@example.com` 这类**字面写的是单词 "secret-value"**，域名是 `example.com`，是测试用的假数据，不是泄漏的真实密钥）。仓库里也没有 `.env`/`.env.example` 文件（`Glob **/.env*` 零命中）——所有配置都通过构建期 `VITE_*` 变量或容器启动期 `ANALYTICS_*` 变量传入，没有随仓库分发任何默认凭据。

---

## 6. 技术栈 / 构建命令 / env 清单 / 鉴权方式 / 画布持久化格式 / License

### 技术栈

- **前端**（`web/`）：Vite 7 + React 19 + React Router 7 + TypeScript 5 + Ant Design 6（含 pro-components）+ Tailwind 4 + Zustand 5 + TanStack Query 5 + axios + `localforage`（IndexedDB 封装，画布/素材/生成记录持久化用）+ i18next（中英双语）。包管理器 **bun**（`bun.lock` 为主，`package-lock.json` 是 npm 兼容备份）。
- **本地 Agent**（`canvas-agent/`）：Node ≥18 + TypeScript，`@modelcontextprotocol/sdk` + Express 5 + Zod + Winston，内嵌依赖 `@openai/codex`，发布为 npm 包 `@basketikun/canvas-agent`，通过 `npx` 拉取运行，暴露 32 个 MCP 工具（`canvas-agent/src/canvas/schemas.ts:10-45`，覆盖画布增删改、四种生成模式、素材/提示词检索）。
- **画布节点插件 SDK**（`plugins/canvas/sdk`）+ 6 个官方示例插件（html/markdown/panorama/sticky-note/svg/template），各自独立 `package.json` + `build.mjs`（esbuild 类构建，未展开逐个读取）。

### 构建 / 部署命令（原文摘录，仅供人工在监督下执行，本审计未执行任何一条）

```bash
# 本地开发（README.md:74-80）
git clone git@github.com:basketikun/infinite-canvas.git
cd infinite-canvas/web
bun install
bun run dev            # vite --host 0.0.0.0 --port 3000

# 类型检查 / 格式化（web/package.json:9,11-12）
bun run typecheck       # tsc --noEmit
bun run format:check    # prettier --check .

# 生产构建
bun run build            # vite build → web/dist

# Docker（README.md:82-90；docker-compose.yml 用的是预构建镜像 ghcr.io/basketikun/infinite-canvas:latest，不会本地重新构建）
docker compose up -d
# 如需从源码构建镜像，用根目录 Dockerfile（多阶段：oven/bun:1.3.13 构建 → nginx:1.27-alpine 运行）
docker build -t infinite-canvas .

# canvas-agent（canvas-agent/package.json:16-22）
bun run dev    # tsx src/index.ts
bun run test   # tsx --test 五个 *.test.ts
bun run build  # tsc -p tsconfig.json
```

### env / 配置文件清单

| 变量 | 生效阶段 | 位置 | 默认值 |
|---|---|---|---|
| `VITE_DOC_URL` | 构建期 | `web/src/constant/env.ts:3` | `https://docs.canvas.best` |
| `VITE_PLUGIN_REGISTRY_URL` | 构建期 | `web/src/constant/env.ts:6` | jsDelivr 官方插件注册表（见第 3 节） |
| `VITE_DEV_PLUGINS` | 仅本地 `bun run dev` | `plugin-loader.ts:154` | 未设置则不生效，逗号分隔的插件 URL 列表 |
| `ANALYTICS_GA4_ID` / `ANALYTICS_BAIDU_ID` | 容器启动期 | `docker-entrypoint.sh` → `web/public/config.js` | 空（关闭） |
| `PORT` | 部署期 | `render.yaml:9-10` | `3000` |

没有随仓库分发 `.env`/`.env.example`；`web/public/config.js` 是运行时生成文件，不建议直接改，改 Docker 环境变量或 `docker-entrypoint.sh`。

### 鉴权方式

**没有服务端账号体系。** AI API Key 由用户在配置页填入，存浏览器本地（`localforage`/IndexedDB），前端直连用户指定的 OpenAI 兼容端点（`AGENTS.md:84` 项目自己的说明也这么写）。WebDAV 同步（`web/src/services/webdav-sync.ts`）用的是用户自填的地址+账密，同样是 BYO。Codex app 插件清单里的 `"authentication": "ON_INSTALL"`（`plugins/infinite-canvas/.codex-plugin/plugin.json:15`）是 Codex 应用市场自己的安装期授权流程，与本项目无关。

### 画布 JSON 持久化格式（为 `schemaVersion` 做准备）

MCP 协议层的权威类型定义在 `canvas-agent/src/canvas/types.ts:1-7`：

```ts
type Position = { x: number; y: number }
type Viewport = { x: number; y: number; k: number }
type CanvasNodeType = "image" | "text" | "config" | "video" | "audio"
type CanvasNode = { id: string; type: CanvasNodeType; title?: string; position: Position; width: number; height: number; metadata?: Record<string, unknown> }
type CanvasConnection = { id: string; fromNodeId: string; toNodeId: string }
type CanvasSnapshot = { projectId?: string; title?: string; nodes?: CanvasNode[]; connections?: CanvasConnection[]; selectedNodeIds?: string[]; viewport?: Viewport; clientId?: string }
```

**当前没有 `schemaVersion`/`version` 字段**——与 README 的警告一致（"项目目前处于开发阶段，不保证历史数据兼容...各种本地存储格式都可能直接调整"）。这是唯一 MCP 层暴露的契约；浏览器端 IndexedDB 里实际持久化的完整结构（含生成历史、素材引用等）没有单独展开逐字段核对，只核实了这个 DTO 层——将来加 `schemaVersion` 建议从这个类型和 `canvas-agent/src/canvas/schemas.ts` 的 zod schema 两处同步加。

### License 与署名

- 根 `LICENSE`：MIT，`Copyright (c) 2026 basketikun`。
- **`CHANGELOG.md` v0.15.1（即当前 HEAD 这一版）**："[调整] 项目开源协议更换为MIT，允许所有人免费用于开源、闭源和商业场景。"——协议是**最近才主动改的**，且明确写了目的就是允许商用闭源，对星芒这类场景是好消息。
- `README.md:30`（非强制，MIT 本身只要求保留版权声明，这条是作者的额外请求）："二次开发与 PR 请保留原作者信息和前端页面标识。"
- **不一致项，需人工核实**：`plugins/infinite-canvas/.codex-plugin/plugin.json:11` 单独写着 `"license": "AGPL-3.0"`，与根 LICENSE 的 MIT 冲突。结合 CHANGELOG 时间线看，大概率是 v0.15.1 从别的协议改成 MIT 时，这个子清单文件忘了同步改——但这只是推测，**在把这个 Codex 插件子目录当作 MIT 处理之前应该先确认**（问作者或看 git blame/历史 tag 的旧 LICENSE）。AGPL-3.0 是强 copyleft，网络服务场景下有开源回馈义务，和 MIT 的宽松程度天差地别，不能想当然按根协议处理。

---

## 7. 醒后监督执行的下一步

### 确切命令（人工监督下按需执行，今晚未执行任何一条）

```bash
cd K:\星芒\xingmang-canvas\web
bun install              # 第一次装依赖，postinstall 可能执行任意脚本——建议先 bun install --dry-run 或翻一遍 package.json 的 scripts 字段确认无异常脚本，再正式装
bun run typecheck        # 确认仓库本身类型干净
bun run dev              # 起本地 dev server，默认 http://localhost:3000
```

如果只想跑 Docker（不触碰源码依赖）：

```bash
cd K:\星芒\xingmang-canvas
docker compose up -d     # 注意：这条默认拉 ghcr.io 预构建镜像，不是从本地源码构建
```

### 正式集成前的完整清单

| 项目 | 现状 | 需要做的事 |
|---|---|---|
| 更新检查指向原仓库 | `use-version-check.ts:7-8` 硬编码 `raw.githubusercontent.com/basketikun/...` | 改成指向星芒自己的版本源，或直接去掉这个功能 |
| GitHub 链接 | `github-link.tsx:15` | 替换或移除品牌链接 |
| 文档站链接默认值 | `env.ts:3` `docs.canvas.best` | 构建期用 `VITE_DOC_URL` 覆盖，或改默认值 |
| 官方插件注册表 | `env.ts:6` 默认指向 basketikun 的 jsDelivr/GitHub 分支 | 决定是否继续信任原注册表、换成星芒自己维护的注册表、或用 `VITE_PLUGIN_REGISTRY_URL` 整体替换 |
| 插件系统本身的风险披露 | `SECURITY.md` 用英文写明"装插件=交出页面内 API Key" | 中文 UI 里要有等价的用户告知，不能因为翻译/白标就丢掉这层警告；同时评估是否要收紧成白名单 |
| AGPL-3.0 标注的插件子目录 | `plugins/infinite-canvas/.codex-plugin/plugin.json:11` | 用之前先确认这条协议标注是否有效，必要时联系作者或换掉这部分再用 |
| 默认 AI 供应商预设 | `use-config-store.ts:67-69` 只有 OpenAI/Gemini/Ark 三条 | 视产品需求加一条指向 `xm.solov.cc` 的预设（做法参照现有三条） |
| 提示词库默认源 | `prompt-source-presets.ts:12-32` 六个第三方 GitHub 仓库 | 白标场景下评估是否保留这些第三方内容源，或换成自己的 |
| 归属 | README 请求保留原作者信息（非强制） | 产品决策：静默改造 vs. 保留署名/联系作者定制（README 明确写了"项目定制二次开发需求可联系"，邮箱 1844025705@qq.com，作者本身提供有偿定制服务，这是一条比"自行剥离"更省事、也更不容易踩权利纠纷的路） |
| 返佣/邀请码 | 应用代码里没有，第 1 节已确认 | 无需处理；如果以后要接 `xm.solov.cc` 账号体系，`aff_code` 是新增对接工作 |
| 账号/支付端点 | 应用代码里没有，第 2 节已确认 | 无需处理 |

---

## 用户决策（2026-08-09）

**决策1（AGPL 冲突）→ 已消解，无需联系作者**：`.codex-plugin/` 是把画布上架到 OpenAI Codex 应用市场的打包清单，与本产品（自建 Electron 桌面白标）无关。集成画布时**直接删除 `plugins/infinite-canvas/.codex-plugin/` 目录**即可，AGPL-3.0 标注随之失效，无需按 AGPL 处理。

**决策2（插件安全模型）→ 改为：移除联网插件系统（用户改判，2026-08-09）**。不保留"从任意 URL 加载插件"的能力，从源头砍掉 API Key 泄露路径，不做"保留+中文告知"。
实施口径（画布集成时执行，当前仅审计+占位未集成）：
- **移除**（安全风险本体）：任意 URL 下载执行机制——`web/src/lib/canvas/plugin-loader.ts` 的 `installPluginFromUrl`/`fetchPluginSource`、用户自填 URL 安装框、`web/src/lib/canvas/plugin-registry.ts` 的 `fetchOfficialPlugins`、远程注册表 `PLUGIN_REGISTRY_URL`/`VITE_PLUGIN_REGISTRY_URL`/`VITE_DEV_PLUGINS`、插件管理弹窗 `canvas-plugin-manager-modal.tsx`。
- **保留但改为构建期静态打包**（否则画布残废）：6 个内置节点类型（html/markdown/panorama/sticky-note/svg/template，`plugins/canvas/sdk` + 示例）当前是用插件 SDK 实现的，必须静态 bundle 进产物、不走运行时拉取。
- 连带：`.codex-plugin/` 目录一并删除（决策1）。
- 净效果：无任何"从外部拉码在 API Key 同源环境执行"的路径；画布基本节点功能不受影响。集成时先由代理核实内置节点与 loader 的耦合度，再给用户确认拆除方案。
