## 用户

- 画布换成新版，界面和工具都换了一批。旧画布几个会丢内容的毛病一起修掉：切换项目后按撤销，不会再把别的项目或空白画布
  存进当前项目；切到项目副本不会带上原项目的「生成中」和候选图；便签里写网址、`TODO:` 这类内容，关掉重开不会丢；
  生成时改过提示词，结果出来后节点照样标「待更新」；小地图、专注模式的开关重开项目后还在。

## 开发

- #1393 1b：`canvas-v2/src`、`canvas-v2/shared` 换成 xingmang-canvas 的 `kernel-v0.1.0`（a8db24a），由
  `scripts/sync-canvas-kernel.mjs` 同步，`canvas-v2/KERNEL_SOURCE.json` 记 tag、提交号和每个文件的 sha256。
  桌面自有文件只改 `canvas-v2/vite.config.ts`（入口那份配色换成 UI v4 的、`__XINGMANG_CANVAS_HOST__` 定为桌面）和
  `canvas-v2/package.json` 的说明，tsconfig 照旧 ES2022。以后改画布去 xingmang-canvas 改，再按 tag 同步（AGENTS.md T13）。
- `e2e/canvas-*.tsx` 夹具改由 `canvas-v2/tsconfig.json`（`canvas:prepare` 第一步）做类型检查，根 tsconfig 不再收它们：
  关窗夹具会把整个内核拉进根 tsconfig，那边的 `react` 指向旧界面的 React 18 类型，内核按 React 19 写（`inert`、
  `RefObject<T | null>`），在那里编不过。
- 审查 #1489 的 D01、D03（画布那半）、F02、O13、O15 随新内核修掉；D07、D08、D09 新内核里还在，回 xingmang-canvas 修。
- 旧画布的 74 个测试文件由内核里的 `*.v2.test.ts` 接替：53 个原样、21 个改过期望或退役，逐条理由见 xingmang-canvas
  `docs/canvas-kernel-v2-tests.md`。画布测试从 74 个文件变成 495 个（6834 条），Linux 上串行约 7 分钟；
  `scripts/vitest-shards.mjs` 记上最慢的五个，Windows 四片照旧按时间发牌。
- 新的 `electron/canvas-kernel-capabilities.test.ts` 钉住内核认得出桌面的 `capabilities()` 声明：内核读不懂时会悄悄
  退回 v2 那套能力，哪里都不报错。
- 随内核带进来的 OpenCV 抠图运行时（OpenCV 4.13.0、Emscripten 4.0.20、Apache-2.0）登记进第三方台账；它里面 Emscripten
  通用的读文件代码有 1 处 `fetch`、5 处 `XMLHttpRequest`，出网门禁只给这一个文件开例外、个数钉死（放宽，yoyo 10-28 亲手同意）。
  这份构建不读外部文件，画布 CSP 的 `connect-src` 也只放行 `xingmang-asset:`。
- `docs/RELEASING.md` 第 8 节改对：0.2.22 不认新内核写的字段，退回期间在 0.2.23 里改过的画布工程打不开；
  退回下限不动，画布出问题用撤回加快修版。
