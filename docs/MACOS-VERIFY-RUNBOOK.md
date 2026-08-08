# macOS 真机验证 Runbook · 第二轮（2026-08-09）

> 验证对象：首轮发现的三项缺陷修复——Grok agent 软链装卸对称（#16）、启动期 IPC 竞态（#17）、codesign 三态区分（#15/#39-2）、卸载残留文案（#18）。
> 代码载体：`xingmang-macos-verify.bundle`（已重打，头为本轮修复提交）。首轮已验证项不必重跑。

## Mac 侧准备

```bash
# 若保留了首轮的克隆，直接增量拉取；否则按首轮方式重新 clone
cd xingmang-ai-manager
git fetch /path/to/xingmang-macos-verify.bundle local/integration:refs/remotes/bundle/local-integration
git checkout local/integration && git merge --ff-only bundle/local-integration
npm ci
```

## 第 1 步：门控测试真跑

```bash
npx vitest run electron/macos-grok.test.ts electron/macos-codex-app.test.ts electron/codex-desktop-service.test.ts electron/system-service.test.ts
```

预期 0 失败。本轮新增的 darwin 用例（agent 建链、三态分界、孤儿 realpath 归一化）在此真实执行。

## 第 2 步：全量门槛

```bash
npm run typecheck && npm test
```

预期：typecheck 三连 0 错；测试 0 失败。

## 第 3 步：#16 核心——装卸可重复性（本轮最重要）

**前提：先把 `~/.grok` 挪走**（`mv ~/.grok ~/.grok.bak`），确保没有 7 月官方安装器的残留掩盖原 bug。

1. 应用内安装 Grok → 确认 `~/.grok/bin/grok` 与 `~/.grok/bin/agent` **都存在**且 `readlink` 指向同一目标。
2. 应用内卸载 → 预期 `manual-required`（`.removing` 设计使然，非 bug），且帮助对话框给出**真实的 `rm -f` 清理命令**（不再是旧的「缺 agent 不能卸」或无命令兜底）。
3. **再装一次 → 再卸一次**——必须与第 2 步行为一致。这是原 bug 的死穴：以前 agent 残留耗尽后自动卸载永久失效。
4. 复制展示的清理命令在终端执行 → 确认只删列出的文件、不碰 `downloads/` 下未列出的内容。

## 第 4 步：#18 孤儿提示

卸载前在 `~/.grok/downloads/` 放一个假旧版本文件 → 卸载文案应**提及**它（数量/大小/文件名），但清理命令**不包含**它、执行后它仍在。

## 第 5 步：#15 三态——刻意制造一次 codesign 慢速

冷启动或高负载时立即触发扫描（重启后马上刷新 Codex 桌面端状态数次）。若撞到超时：UI 应显示琥珀色「检测失败，点击重试」而**不是**「未安装」；点重试应自愈（失败不入缓存）。若制造不出超时，此步记 SKIP 即可（正常路径 `installed: true, detectionFailed: false` 顺带确认）。

## 第 6 步：#17 启动零报错

启动应用后立即查看「反馈与诊断」的运行日志：首轮出现的 9 条「未找到受信任的 Codex CLI 安装」（plugins:list×4、mcp:list×4、models:list×1）应**归零**。随后正常打开 MCP/插件页确认功能无恙、无新延迟感。

## 给 Mac 上 Claude Code 会话的粘贴提示词

> 你在 macOS 验证机上。按仓库 docs/MACOS-VERIFY-RUNBOOK.md（第二轮）执行：第 1、2 步直接跑并记录尾部输出；第 3、4、6 步涉及 GUI，逐步提示我人工操作并等我反馈；第 5 步尽力制造，造不出记 SKIP。全部完成后输出结构化报告：每步 PASS/FAIL/SKIP + 关键输出片段 + 异常详情。不要修改任何代码、不要 commit/push。

## 结果回报格式

```
步骤1: PASS/FAIL（vitest 尾部）
步骤2: PASS/FAIL（typecheck + 测试尾部）
步骤3: PASS/FAIL（装→卸→再装→再卸 四段各自结果 + agent 链确认）
步骤4: PASS/FAIL（孤儿被提及且未被删）
步骤5: PASS/SKIP/FAIL（三态呈现）
步骤6: PASS/FAIL（启动报错计数 之前9 → 现在N）
异常: 无 / 详述
```
