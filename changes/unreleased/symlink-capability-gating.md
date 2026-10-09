## 开发

- Windows 默认配置（非管理员 + 开发人员模式关）下 `npm test` 的 9 个失败清零（#40 的 A 类）。`fs.symlinkSync`
  需要 `SeCreateSymbolicLinkPrivilege`，本机没有时这 9 条在被测代码跑起来之前就 EPERM，报的是机器配置、
  不是仓库状态。新增 `electron/symlink-capability.test-support.ts` 一次性探测能否创建真符号链接，
  `safe-local-data`（4 条）、`runtime-log`（2 条）、`backups`、`path-identity`、`relocated-folders`
  各自的符号链接用例改用 `it.runIf(canCreateSymbolicLink)` 门控。**断言一个字没改**——换联接会改掉被测属性
  （这些用例验的就是 I8 对符号链接的防护），所以只能整条跳过。
- 覆盖不会因此静默消失：`electron/symlink-capability.test.ts` 在 `CI` 下断言探测必须为真，runner 一旦失去
  该特权就当场红，而不是 9 条悄悄变成 skip。门控前已核实 CI 的 windows runner 确有该特权——当时代码里
  没有任何跳过而 CI 全绿。实现后又把探测临时强制为 true 复跑，9 条如期重新执行并复现原 EPERM，证明门控
  挂在正确的用例上。
- `AGENTS.md` 第 3 节与 `docs/TEST-BASELINE.md` 的 Windows 基线从「0~9 个环境相关失败」改为 **0**，
  并写明跳过不算失败、想在本机真跑该开什么。#40 的 B 类（5 条卡 vitest 默认 5s 超时）此前已随
  `test:vitest` 的 `--testTimeout=30000` 消失，本次复核 11304 条用例零超时。
- 新增根目录 `.nvmrc`（22，与 `quality` 工作流一致）。仓库此前既无 `.nvmrc` 也无 `engines`，本机 Node 与 CI、与 Electron 自带的 Node 三者各走各的。实测系统 Node v24.13.0 上 `fs.rmSync(中文名非空目录, { recursive: true, force: true })` 会让进程 fail-fast abort（`0xC0000409`），`provider-sessions.test.ts` 的 worker 因此无声死掉、整个文件 43 条一条都不算，vitest 退出码恒为 1。Electron 43.6.0 自带的 Node 24.20.0 与 CI 的 Node 22 都正常，产品与 CI 均不受影响。现象、触发条件与排查过程记进 `docs/TEST-BASELINE.md`。
