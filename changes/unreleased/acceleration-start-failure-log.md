## 用户

- 加速连接失败时，日志里会记下具体原因（内核没起来、架构不符、系统代理授权未完成等），排查不用再靠猜。界面文案不变。

## 开发

- 加速连接与线路检测失败原本不留任何痕迹：`startAcceleration` 失败时返回带错误文案的状态而不是抛错，`ipc.ts` 因此把一次失败的连接记成 info 级的「完成」，而真实错误在 `connectionFailure()` 换成固定文案时就被丢掉了。2026-09-19 交给测试的 Mac 包加速起不来，日志里除了这条「完成」什么都没有。
- 新增 `AccelerationStartFailureStage` 封闭枚举与 `classifyAccelerationStartFailure()`，在 backend 里按失败阶段（`runtime` / `verify` / `ledger` / `proxy`）加错误文本归类，经 worker 的既有诊断通道送到主进程，由 `main.ts` 以 error 级写进 `runtime.jsonl`。
- 跨进程只传枚举成员，不传原始错误文本 —— 与 `onDiagnostic` 既有的「stage only」约束一致：运行时与原生代理助手抛出的错误可能带私有路径或代理细节（I13）。host 侧按枚举白名单过滤，未知 stage 直接丢弃。
- 行为不变：用户看到的文案、状态机、时长计费都没有改动，只增加日志。
