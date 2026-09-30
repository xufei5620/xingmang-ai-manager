## 开发

- 第二十二批 6（CI 假红）。单元测试不再自己起 PowerShell：`codex-desktop-service.test.ts` 的四条（进程探测、合并探测、两条喂假 WMI 的关窗 / 打开探测）和 `external-client-runtime.test.ts` 的两条（假注册表下的外部客户端清单、已记住签名的解码）搬进新的 `e2e/windows-powershell-probes-smoke.mjs`，在 `windows-package` 作业编译之后对编译产物各真跑一次，每条单独 90 秒预算并打印耗时，步骤兜底 6 分钟。`windows-store-app-launch.test.ts`「reads the current account on Windows」（9-30 在 runner 上每次跑满 90 秒拿回空 SID）同样改成查脚本文本和解析，真跑那一遍进冒烟；冒烟另外把正式代码走的那条路（`trustedCommandEnvironment` 下的同一脚本、`inspectWindowsStoreAppLaunchContext` 本身）各跑一次、只打印结果和耗时，为「单独起的探测为什么卡满预算」留证据。单元测试那边改查生成的脚本文本（`scanPowerShell` 引号括号）和解析函数，外部客户端那条改用夹具喂运行时。
- `scripts/ci-workflow-config.test.cjs` 新增门禁：`electron/`、`src/` 下的测试文件不许直接用 `execFile*` / `spawn*` / `runCommand` 起 `powershell.exe`；冒烟必须在编译之后、带步骤超时。
