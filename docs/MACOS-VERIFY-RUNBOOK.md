# macOS 真机验证 Runbook（2026-08-08 安全链批次）

> 验证对象：#37 残余三处 codesign 信任判定的环境净化、#38 系统目录优先排序（关闭证据）、#39 签名校验缓存 TTL。
> 代码载体：`xingmang-macos-verify.bundle`（含完整 `local/integration` 分支，无需访问 GitHub）。
> 结果回报：按文末格式把各步 PASS/FAIL 与关键输出贴回 Windows 协调会话。

## Mac 侧准备

```bash
git clone /path/to/xingmang-macos-verify.bundle xingmang-ai-manager -b local/integration
cd xingmang-ai-manager
npm ci
```

需要 Node 22+。若要跑第 3 步的功能回归，机器上需可安装 Grok CLI（会真实装/卸）。

## 第 1 步：让 Windows 上跳过的用例真跑（最高价值，先做）

```bash
npx vitest run electron/tool-installation.test.ts electron/system-service.test.ts electron/macos-codex-app.test.ts electron/macos-platform.test.ts
```

预期：**0 失败**。Windows 上被 `runIf(darwin)` 跳过的用例（含本批新增 4 个）在此真实执行，直接对真 `/usr/bin/codesign`、`/usr/bin/env`、`/usr/bin/git` 验证。

## 第 2 步：全量门槛

```bash
npm run typecheck && npm test
```

预期：typecheck 三连 0 错；测试 0 失败（macOS 基线本就全绿）。

## 第 3 步：#37 功能回归（真实 Developer ID 签名二进制）

1. 在应用里安装 Grok CLI（macOS 原生 npm 路径），确认完成且 CLI 可用。
2. 在应用里卸载 Grok CLI，确认自动卸载路径成功——这是改动过的卸载校验点（system-service.ts:2332）的关键回归。
3. 从应用启动 Codex 与 Grok 终端各几次，确认正常打开——这是流量最高的修复点（CLI 解析校验）的回归。

## 第 4 步（可选，注入剥离直证）

在 `runDarwinNativeVerificationCommand`（tool-installation.ts:514）或 `buildDarwinTrustedVerificationRunner`（system-service.ts:290）内临时加一行 `console.error(Object.keys(...))`，然后：

```bash
export DYLD_INSERT_LIBRARIES=/tmp/x.dylib NODE_OPTIONS=--require=/tmp/x.js
npm run dev   # 触发一次启动/安装/卸载
```

预期：日志键列表**不含**这两个变量、含 HOME/PATH。**验证后删掉调试行，不要提交。**

## 第 5 步：#39 缓存行为

1. 打开应用，在显示 Codex 桌面端状态处快速刷新 5 次；旁开 `log stream --style compact --predicate 'eventMessage contains "codesign"'` 观察——预期 **1 次** codesign 调用而非 5 次。
2. 不动 `/Applications/Codex.app`，等 5 分钟后再刷新——预期出现**第 2 次**调用（TTL 到期，属设计不是 bug）。
3. 可选：`codesign --verify --deep --strict /Applications/Codex.app` 冷计时一次，确认仍远低于 5s 预算（历史实测 1.79-2.30s）。

## 给 Mac 上 Claude Code 会话的粘贴提示词

> 你在 macOS 验证机上。按仓库 docs/MACOS-VERIFY-RUNBOOK.md 执行：第 1、2 步直接跑并记录完整尾部输出；第 3、5 步涉及 GUI 操作，逐步提示我人工执行并等我反馈；第 4 步先问我是否要做。全部完成后输出结构化报告：每步 PASS/FAIL + 关键输出片段 + 异常详情（若有）。不要修改任何代码（第 4 步的临时调试行除外，用后即删）。不要 commit/push。

## 结果回报格式

```
步骤1: PASS/FAIL  （vitest 尾部摘要）
步骤2: PASS/FAIL  （typecheck 退出码 + 测试尾部摘要）
步骤3: PASS/FAIL  （装/卸/启动各自结果）
步骤4: 做了/跳过  （键列表片段）
步骤5: PASS/FAIL  （两次观察的 codesign 调用次数）
异常: 无 / 详述
```
