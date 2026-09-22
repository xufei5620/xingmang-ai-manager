## 用户

- 从软件里打开 Codex 桌面端（ChatGPT 客户端）时，如果加速还没连上，软件会先自动连一次再打开，
  不用先去「游戏加速」里点连接。界面语言因此能稳定按中文显示。
- 连不上（本机加速组件起不来、免费时长已用完、未登录、或检测到其他代理与 VPN）照常打开，
  不会卡住也不会报错，只在日志里留一句。
- 已经在用加速的，软件一律不动你的线路，也不会替你换线。
- 自动连上的这段加速不会自动断开，用完请在加速页自行停止；这段时长计入当前账号的免费时长。

## 开发

- 新增 `electron/codex-desktop-acceleration.ts`：打开前的连接协调器。走的是与用户点「连接」
  完全相同的 `acceleration-service.startAcceleration`（完整连接、会改系统代理），**不是**
  `download-acceleration.ts` 的下载专用线路——桌面端是独立进程，只认系统代理。
  `active` / `connecting` / `stopping` 一律不动，`exhausted`、额度为 0、`unavailable`
  与读不到状态都跳过；15 秒预算，超时、失败、后端拒绝（冲突检测）全部收敛成一句日志，
  `ensureConnected` 永不抛错。同一时刻只连一次（连点两下「打开」共用同一个请求）。
  不含 Electron 依赖，可单测。
- `codex-desktop-service.ts` 增加可选 seam `prepareAcceleration`，在 macOS 与 Windows 两条
  拉起路径上、确认桌面端已安装之后、真正启动之前各调用一次；缺省不做，旧调用方行为不变。
- `system-service.ts` 仅做透传（`prepareCodexDesktopAcceleration`），`main.ts` 把它接到
  加速服务上（模式固定 `system-proxy`，不指定线路，沿用用户选过的那条）。IPC 契约与渲染层
  一行未动。
