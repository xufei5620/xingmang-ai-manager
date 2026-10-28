# 无限画布第三方来源台账

本台账只记录实际进入星芒仓库或运行时依赖图的代码、素材、字体和模板。仅用于产品行为研究的项目单列为 idea-only，不构成复制或许可授权。机器可读的事实来源为 `docs/canvas-third-party.json`，本文件用于解释采用边界。

## 运行时依赖

| 项目 | 版本/Commit | 来源 | 许可证 | 用途 | 本地修改 |
|---|---|---|---|---|---|
| React Flow | `@xyflow/react@12.11.3` | `https://github.com/xyflow/xyflow`，`packages/react` | MIT | 画布视口、节点、连线和控件 | 无上游源码复制；通过公开 API 使用 |
| Lucide React | `lucide-react@0.468.0` | `https://github.com/lucide-icons/lucide`，`packages/lucide-react` | ISC | 画布工具栏、历史和候选操作图标 | 无上游源码复制；通过公开 API 使用 |
| React | `react@18.3.1` / `react-dom@18.3.1` | `https://github.com/facebook/react` | MIT | 渲染器 | 无上游源码复制 |

后续新增运行时依赖必须补充精确版本、仓库、子目录许可证例外和用途。直接迁移或改编上游文件时，必须额外记录 commit SHA、原路径、目标路径、版权声明和修改摘要。

上表的 React 版本是 `canvas-v2/package.json` 里写的；画布实际由 `canvas:prepare` 用主仓根目录的依赖构建，跑的是根目录锁定的 `react` / `react-dom` 19.2.8。

## 随内核带进来的第三方构建产物

画布内核来自 xingmang-canvas，按 tag 同步进 `canvas-v2/`（#1393）。内核里有一份第三方源码编出来的运行时，原样随内核进来：

| 项目 | 版本 | 来源 | 许可证 | 目标路径 | 用途 | 和上游比改了什么 |
|---|---|---|---|---|---|---|
| OpenCV GrabCut 运行时 | OpenCV 4.13.0（`https://codeload.github.com/opencv/opencv/tar.gz/refs/tags/4.13.0`，sha256 `1d40ca01…3017d`），Emscripten 4.0.20（release commit `c387d7a7e9537d0041d2c3ae71b7538cc978104e`） | xingmang-canvas `canvas-kernel/src/vendor/opencv-grabcut/` | Apache-2.0（OpenCV）；GrabCut、GCGraph 另带 Intel 的许可声明；Emscripten 运行时的许可证一并保留 | `canvas-v2/src/vendor/opencv-grabcut/runtime/opencv-grabcut-<sha256>.js`，打包成 `dist-canvas/assets/layer-grabcut-worker-*.js`（约 1.8MB） | 图层抠图，只在用户手动框选时在同源的模块 Worker 里跑 | 算法源码不改；只编 core、imgproc、js，导出名单只加 `setRNGSeed`、`grabCut`；`WASM=0`、`DYNAMIC_EXECUTION=0`、不开线程；`bounded-memory.patch` 把堆限在 512MiB |

源码包、工具链的下载地址和完整哈希、构建参数、许可证全文的哈希都在同目录的 `manifest.json`，许可证全文在 `LICENSES.txt`，也印在运行时文件开头。运行时文件名就是它内容的 sha256。

这份运行时是 Emscripten 生成的通用加载代码，里面有 1 处 `fetch`、5 处 `XMLHttpRequest`：是 Emscripten 读外部文件用的通用代码，这份构建不读任何外部文件（同目录 `README.md`）。画布窗口的 CSP `connect-src` 只放行 `xingmang-asset:`，它也连不出去。出网门禁 `scripts/verify-canvas-network-boundary.test.cjs` 只给这一个文件登记了这几处，个数钉死。

## 自有实现

以下能力分为已经实现和计划实现两类，均按星芒数据契约独立开发，不复制 React Flow Pro 示例或其他项目源码。

### 已实现

- React Flow 画布骨架、三类基础节点与本地宿主桥
- 工作流 schema v2、v1 迁移、sanitizer 和 secret-free serializer
- AI 操作有界队列与暗色启动首帧

### 本版本已实现

- Undo/Redo、Copy/Paste、动态 Grouping、自动布局和资产拖放
- `CanvasNodeDefinition` 注册表与十类核心媒体节点
- 主进程运行引擎、资产索引、运行历史、候选采纳和三套模板
- 暗色主题、中文节点组件和有界 `.xingcanvas` 项目格式

## Idea-only 研究来源

| 项目类别/代表 | 许可状态 | 仅吸收的行为需求 | 禁止进入仓库的内容 |
|---|---|---|---|
| ComfyUI、Nebula Nodes、flyreq-image-studio | GPL/AGPL | 队列、缓存、增量失效、断线恢复 | 源码、UI、文案、素材 |
| tldraw、Jaaz、SHUO-Canvas、VisionFlow | 商业/非商业/source-available | 画布交互和媒体工作流验收项 | 源码、视觉资产、独特表达 |
| Flowboard、Loomic、infinite-kanvas、DirectorsConsole | 无可靠许可证 | 功能需求和独立测试规格 | 任何源码、截图、文案、素材 |
| hero8152/Infinite-Canvas | 非商业 source-available（审查 commit `1c141a57`） | 可复用内容库、引用感知清理、有界批处理的独立产品需求 | 任何源码、UI、截图、文案、提示词、工作流、素材、插件和独特交互表达 |
| open-storyboard-canvas、wassermans-filmmaker-suite | GitHub 未识别可靠许可证 | 分镜和影视工作流的类别级需求 | 任何源码、截图、文案、素材、模板和独特交互表达 |
| TapCanvas、DeepFish、TwitCanva 等宽松许可项目 | MIT/Apache-2.0 | 节点注册、剪贴板、分组、素材和 Storyboard 行为 | 未经逐文件审计的源码或资产 |

GitHub API 返回的许可证标签只作为调研线索，不替代许可证原文和逐文件审计。README 中声称“MIT”但仓库没有许可证文件时，按无许可证处理。子目录许可证与根许可证冲突时，以更具体的子目录条款为准并暂停迁移。

`hero8152/Infinite-Canvas` 在审查 commit `1c141a5715c04bbf29b4c2cf76fb78739da8cfe8` 的 GitHub SPDX 标记为 `NOASSERTION`，但根目录存在自定义 `LICENSE`，明确禁止修改封装成商业产品，并要求二开保持开源和署名。星芒只记录 README 公开描述的类别级能力，例如多协议模型调用、异步任务、本地 ComfyUI、素材采集、媒体变换和循环编排；不复制其源码、工作流 JSON、系统提示词、插件、截图、文案或视觉表达。

## 素材、字体和模板

第一版不引入外部字体、截图或示例媒体。内置模板使用星芒自有 JSON 定义和纯色占位缩略图。任何新增图片、视频、字体或模板示例都必须在本节逐项登记作者、来源 URL、许可证和目标路径。
