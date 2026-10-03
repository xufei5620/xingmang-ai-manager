## 用户

- 工具检测失败时，首页和「安装卸载」页那行小字不再是一串英文：没权限、文件被别的程序占着、文件找不到各说一句中文，
  其余的说原因已经记进日志；都会告诉你点「重新检测」，还不行去「反馈」页导出报告发给客服。
- 星芒开机时 Codex 正开着、因此没补上的新版设置和 Codex 型号菜单，现在关掉 Codex 后 10 分钟内（或切回星芒窗口时）
  会自己补上，不用再等下次打开星芒。

## 开发

- 第二十六批 D：`src/renderer-v2/business-common.tsx` 新增 `detectionFailureMessage`，把探针给的英文原话归成四句中文
  （EPERM/EACCES、EBUSY、ENOENT、其他），原话本来是中文的照旧脱敏后显示。判中文之前先剥掉脱敏占位词「本地配置文件」、
  引号段和路径片段，免得英文原话因为占位词或中文用户名被当成中文。首页工具行、安装卸载页、外部客户端行三处换用它。
- `electron/ipc.ts`：`system:scan` 与 `external-clients:scan` 每次扫完，对检测失败的工具各记一条 warn
  （`runtime` / `cli` / `desktop` / `external-client` 的 `.detection-failed`，原话过 `redactHomeDirectory`），
  英文原因只进运行日志和反馈报告。走缓存的扫描不重复记。
- 第二十六批 E：`ToolTemplateFillResult` 加可选 `pending`：工具可能开着、这次没补的；Codex 型号名单没按账号核对也记在
  codex 头上。`config:fill-template-defaults` 收可选 `retry`：主进程按账号记下开机那轮欠下的，retry 只补那几样，
  换了账号就什么都不做。型号名单「这次动不动」改为在本机看完再交回结果，按账号核对照旧放后台；不是当前账号写的 Codex
  配置不再为型号名单起进程看它开没开。补做那几次的日志带 `retry: true`，型号名单补做记 `codex-model-catalog.sync-resumed`。
- 渲染层 `features/app/template-fill-retry.ts`：有 pending 时每 10 分钟、或窗口回到前台（离上一次至少 2 分钟）带 retry
  再要一次，补上、不欠了、换账号或满 6 次（约一小时）就停。真补上了照旧出「已把工具设置补齐到最新」，现在可能在用着时出现。
