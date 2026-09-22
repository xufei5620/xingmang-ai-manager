## 用户

- 反馈报告多了一段「运行环境」：电脑里几样运行环境的版本和位置、Codex 桌面端的版本、大致在国内还是海外网络，以及软件装在哪、数据放在哪。发给客服后不用再被一条条追问。

## 开发

- `feedback-environment.ts` 新增纯函数 `buildFeedbackRuntimeLines` 与 `pickFeedbackRuntimeSnapshot`：只读上一次扫描的 `SystemSnapshot`（`latestTraySystem`），不为报告另起探测；网络位置在挑字段那一步就只剩 `region`，公网 IP 与国家代码进不了报告构造器（I13）。
- `runtime-log.ts` 加第三个段落读取器 `attachHostDescriber`，「运行环境:」排在「工具与配置:」之前，同样有 2 秒预算、同样过 `redactHomeDirectory`；头部 `Node.js:` 改名 `软件内置 Node:`。
- Windows 的「运行权限」按 `windowsCliExecutionMode` 写：`trusted-only` 也是令牌探测失败时的保守回退，所以写成「以管理员身份运行（或无法确认，按管理员处理）」；非 Windows 不出这行。npm 全局目录不在快照里，没有为它加探测。
