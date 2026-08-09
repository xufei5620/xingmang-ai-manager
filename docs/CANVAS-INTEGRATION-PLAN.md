# 画布集成 + 账号变真 计划（2026-08-09 起）

> 用户令：「开始集成，界面全部做好一起看」。顺序由用户定：**先打通真实账号，再上画布**。自主执行、每波 Opus 审查后本地 commit、0 push。最终整个应用组装好一次性给用户看。

## 用户已定决策
1. **登录时序**：先打通真实账号（注册→自动生成 Key），再集成画布让它自动拿 Key。
2. **画布视觉**：保留画布原生外观，不统一到星芒令牌（集成更小）。
3. **署名**：弱化但保留版权声明——前端显著位用星芒品牌，infinite-canvas 原作者信息移到「关于」。MIT 强制的版权声明必须保留（作者的「保留页面标识」是额外请求、非强制，弱化合规）。
4. **画布插件**：移除联网插件系统，内置节点静态打包（见 RECON-canvas 决策2 改判）。
5. **嵌入方式**（协调者按安全默认定）：画布构建成静态文件打包进应用，点导航在应用内隔离窗口打开，通过窄的可审计宿主桥拿 token/存文件；画布拿不到主应用 IPC/Node。

## 阶段
- **阶段 A（账号变真，进行中）**：new-api-client 补 register + 把 W4 的登录/注册/余额/充值 stub 换成真实调用；核心价值链「注册/登录→provision CLI Key（三连调）→写进 CLI 配置」复用既有 config-files 写入路径（I3 明文不留存）。mock 单测；**自动化测试绝不触生产实例**。真机端到端验证需用户提供测试账号或亲自走查。
- **阶段 B（画布准备）**：canvas 仓库移除联网插件、内置节点静态化、接 xm.solov.cc 预设、加 schemaVersion、署名弱化保留版权；构建成静态产物。等侦察代理的耦合分析出来再动手。
- **阶段 C（桌面嵌入）**：静态画布打包进 Electron；隔离窗口 + 宿主桥（getAuthToken 从阶段A的真实账号拿、saveFile/pickFile/notify）；无限画布导航项接真实打开。
- **阶段 D（组装收官）**：全量门槛 + e2e smoke + 整个应用组装好给用户一次看全。

## 测试安全红线
- 阶段 A 自动化测试一律 mock，绝不对 xm.solov.cc 做真实注册/登录/写操作。
- 真机验证由用户提供测试账号或亲自走查。
- 画布仓库构建前先由侦察确认可安全构建；npm install 第三方代码在用户在线时进行。

## 画布侦察结论（2026-08-09，只读，未构建）

**构建**：web/ 是独立 Vite7+React19，`bun run build`→web/dist。base 可相对化（VITE_BASE=./）。障碍=路由用 createBrowserRouter（History API），静态托管深链会 404 → 阶段C 用主应用自定义协议 catch-all 回退 index.html（不改画布源码，不脱离上游）。

**插件移除（协调者简化决策）**：真正内置节点（Text/Image/Video/Audio/Config/Group，builtin-nodes.tsx）零依赖 plugin-loader、本就静态。6 个"官方插件"（html/markdown/panorama/sticky-note/svg/template）当前根本没被静态 import、只走 URL blob-eval 加载。**决策：删掉联网插件系统 + 一并不静态化这 6 个官方插件**（MVP 只保留 6 个真内置节点，功能完整），最干净、零远程代码路径。将来要 markdown/全景等再作为正规 npm 依赖单独加。
- **隐藏风险（侦察新发现，原审计未覆盖）**：panorama/markdown 两插件各自 `import("https://esm.sh/three")`/`marked` ——独立于 plugin-loader 的第二条 CDN 远程代码路径。上面"不静态化这 6 个"的决策**顺带消灭了这条路径**，无需单独处理。
- 删除面：plugin-loader.ts 的 URL 加载函数、plugin-registry.ts、canvas-plugin-manager-modal.tsx + 挂载点、use-plugin-store.ts、env.ts PLUGIN_REGISTRY_URL、vite.config.ts 的 localPluginsManifest。

**宿主桥**：AiConfig 走 zustand-persist→IndexedDB（key infinite-canvas:ai_config_store），无外部注入钩子，宿主需新增注入 token 的挂钩或初始化直写该 key。画布数据 IndexedDB 本地（无需桥）。文件 IO 走浏览器原生（Electron 可跑）。外链仅 4 文件，过白名单/shell.openExternal。

**接 xm.solov.cc**：改 use-config-store.ts 的 defaultConfig.channels[0].baseUrl + 顶层 baseUrl（若 openai 兼容无需加第4种 apiFormat）。默认模型名需产品侧给 xm.solov.cc 实际模型表。

**视觉**：用户选保留原生外观 → 跳过（省中等改动量）。

**署名**：运行时仅 2 处（顶栏 GitHub 图标按钮 + 版本更新弹窗直连原 repo）。弱化=把这两处作者链接收进"关于"、保留版权声明；产品自身 logo/"无限画布"标题保留。

## ✅ 集成完成（2026-08-09）

四阶段全部落地、每波 Opus 审查通过、本地提交（0 push）：
- A 账号变真 `8f40585`：登录/注册接真实 new-api，价值链「注册→自动生成 Key→写进 CLI 配置」（明文四段流向闭合 I3）。
- B 画布准备 `0196df9`（canvas 仓库）：删联网插件系统（远程代码路径消灭）、内置节点保留、接 xm.solov.cc、schemaVersion、署名弱化保留 MIT。
- C 桌面隔离嵌入 `41eb927`：自定义协议 + 独立 sandbox 窗口 + 极窄宿主桥（画布触不到主 IPC/Node，双重密封）。
- D 收官 `a5b606c`：修画布窗口 404 阻断（真机 Playwright 揪出）、孤儿 token 复用、dist-canvas 补 LICENSE。

门槛：typecheck 三连 0 错、vitest 1069 通过/150 跳过/0 失败 + node 79、compile 产出 dist-canvas。真机 smoke 证画布窗口正常打开渲染（canvasRouterShowsNotFound=false、290 元素、零错误、节点工具栏可见）。

### 待用户（一起看时对接）
1. **测试账号**：账号流全链路（注册→Key→写 CLI）仅单测覆盖，未真机走过。给邮箱+密码测试账号或当场注册。
2. ~~**充值 URL**：onRecharge 仍 toast 占位，需 xm.solov.cc 真实充值页地址加外链白名单（I12 全等）。~~（已过时：W4b 已接真实 `https://xm.solov.cc/wallet` 外链并入白名单，见 `account-center.ts` 的 `WALLET_URL` 与 `main.ts:84`。）
3. **真机点画布**：本机（管理员提权+K盘）已验证画布能开能渲染；你在正常环境亲自点一次确认观感（画布保留原生外观、不跟随星芒明暗主题=既定决策）。

### 打磨项（低优先，非阻断）
- 画布首页「连接本地 Agent」段提到「Codex 插件 / @basketikun/canvas-agent」（上游分发模式），白标产品可考虑隐藏/改写。
- 孤儿 token：仅防未来新增，历史孤儿不清理；reveal 到被禁用 token 的极低概率态由画布配置 UI 兜底。
- 已登录用户开画布若无 CLI 配置，画布拿到的是 relay key（与 CLI 同一账号额度）。
