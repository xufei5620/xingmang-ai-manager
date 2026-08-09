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
