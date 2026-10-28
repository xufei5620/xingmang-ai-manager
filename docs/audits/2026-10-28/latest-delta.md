# 最新提交 444ecc18 的 renderer 差异复核

审查提交 `444ecc18ccbac246ddc0162c1cdef14ffcccbe5e`（#1487），相对 `c21be2741af6674b2f422d9891b57fc3d2ba5b7b`。完整阅读 5 个变更文件的 diff，并核对旧问题调用链。没有切换/修改产品工作区；从 `git show <sha>:<path>` 取得原始 Git blob，保存到临时 `latest-delta-source/`，用 Vite 临时加载插件将新 hook/fixture 的原始文本提供给原组件，其他文件仍读当前 c21（本提交未修改它们）。哈希详见 `latest-delta-hashes.json`。

结论：**N2 有关联流程改善，但原“未知提交后重开”问题仍存在；R28-4 仍存在。没有据此新增编号。** c21 的 [前端原基线报告](domains/renderer.md) 与覆盖台账保留原始审查基线，不倒改为最新提交。

## N2：部分改善，原复现仍成立

新代码区分停止结果；服务端可能仍完成的片段继续 resume，重试已有 requestId 时先查询旧任务，排队不再提前清掉请求号。这改善了“有已知任务、停止后仍接回”和“有已知任务、失败后重试”路径。

但未知提交重开的原路径没有闭合：

- 最新 `useVideoStudio.ts:215` 重开时调用 `resumeClip(shot.id, requestId)`，未提供 onMissing。
- `252–262` 的恢复返回 null 直接 `settleShot(item)`；`85–88` 因没有 error 参数，删除 requestId 并回 idle。
- 主进程在提交回包丢失、未拿到 provider jobId 时本就没有可供 resume 查找的本地记录；该主进程本次未修改。null 因此不等于证明服务端没有任务。
- 新 `browser-check.mjs:306–308` 仍把恢复 null 预期为“还没生成”。新增 `379` 的中途停止测试只覆盖仍在同一页面、带 onMissing 错误保留回调的路径，没有覆盖刷新/重开后这个回调消失的路径。

**本轮新执行原页面复现：** 提交后 mock 返回“视频提交结果不明确，服务端可能已创建任务，请勿立即重复提交”；localStorage 保留旧请求号。刷新页面后以旧号 resume，mock 返回 null，页面变成“还没生成”，警告和请求号均消失；再点击生成，产生另一个请求号，两个 mock generate 请求。此处没有真实生成或生产扣款。

**对照：** 同样刷新后 resume 找到旧片段，页面正确变“已生成”，没有新 generate 请求。

证据：`latest-delta-ambiguous-browser-result.json`、`latest-delta-ambiguous-control-result.json`；脚本 `latest-delta-n2-repro.mjs`、`latest-delta-n2-control.mjs`。2 个 Chromium 场景成功，pageErrors 均为空。

修复建议保持：持久化独立“提交结果未知”状态，不把“本地没有任务”降格成“确认未提交”；重开缺失时继续警告，重试需明确说明可能重复计费，服务端可用时使用幂等请求。验收同时覆盖同页停止、普通超时、刷新/重开、找到旧任务、确定未提交；“查不到”不能自动消掉请求号。

## R28-4：仍存在

最新 `useVideoStudio.ts:124` 队列仍是镜头 ID 数组，`339` 只存 ID；`300` 在出队时从可变的 `projectRef.current.settings` 组装请求。`144–182` 迟到目录刷新仍可调整模型与时长，没有把确认时参数固化到批次或逐镜头请求。

**本轮原 VideoStudioPage 3 场景：**

| 场景 | 用户确认 | 实际 4 段请求 | 结论 |
|---|---|---|---|
| 生成中目录移除 Grok | Grok / 每段 3 秒 | 前 3 段 Grok 3 秒，第 4 段 MiniMax 5 秒 | 旧问题仍成立 |
| 生成中目录未变 | Grok / 每段 3 秒 | 4 段均 Grok 3 秒 | 正常对照 |
| 确认前目录已经改变 | MiniMax / 每段 5 秒 | 4 段均 MiniMax 5 秒 | 正常对照 |

生成期间选择器确实已禁用，说明用户无需主动改选，也仍会被迟到刷新影响。原生 catalog/generate 全部 mock，没有真实 AI 请求，三个结果的 pageErrors 和 blockedExternalRequests 均为空。

证据：`latest-delta-model-changed-during-result.json`、`latest-delta-model-unchanged-during-result.json`、`latest-delta-model-changed-before-result.json`；脚本 `latest-delta-r28-4-repro.cjs`。修复：把确认的模型/组/时长/画幅等做成每个队列项不可变请求快照；模型后来不可用时停止、重新确认，不自动 fallback。验收就是以上 3 场景，变化场景第 4 段须用确认参数或明确停止等待重确认。

## 5 文件内容身份与范围

| 文件（video-studio 前缀省略） | Git blob SHA1 | SHA256 |
|---|---|---|
| changes/unreleased/video-studio-stop-keeps-billed.md | d17641ba3a219d0a0c86ee3cee5632473d03bede | 10df28b908774dd6ea2ab4ebddcdbec129c0359ce45ea728025515b62e80a0ec |
| README.md | b501630a52f686f73a0d16b2039d0303f2f9b079 | cc67655ca94ced84397f194bc647a4e0c9f148550140ecbfb5395ce93f03d35c |
| browser-check.mjs | 46069d2fac75b851cec8434fd816cbedd2da8fe3 | bd634281124178dc8eb0ca2a91c4cbbe628207453a4057430e3bd4ee87235a22 |
| page-fixture.tsx | 41c1879e7bc72b7a6da64d4ee5494b9b8ac3bd51 | d57fc16f43c92ed9597501621fa5c7aeab261c7cbe2e034a73f9f8e1cd72914c |
| useVideoStudio.ts | eb790fd4faaaefc69a44073cf454ac1a51035388 | bd5d25ee53d041abed58ff31a1bbb0b856a8b156b6be0658c1df974bc08f1407 |

共 5 个成功定向 Chromium 场景（N2 两个、R28-4 三个）。另一次首次 R28-4 harness 因输出文件前缀替换误改了 testid 而等待超时，修正的仅是临时脚本 selector，产品代码未动；不把该 harness 错误计为产品失败。未在此专项重复执行完整 browser-check 或全量 npm，主审统一执行。所有网络能力是 mock 或本地 fixture；脚本路由拒绝外网，无真实账户、系统安装、模型调用或配置写入。

其余 c21 renderer 旧项不受这 5 文件修改影响；第二轮负 PTS 问题涉及 compose/timeline，这次也没有修改。


主审随后将报告工作区快进到本提交，5个文件的工作树字节均与上述Git blob SHA256一致；最新跟踪清单为2384个文件（旧2383，加1个变更日志，另外4个既有文件变化）。必需检查与额外浏览器验收记录见 [验证页](validation.md)。这是上游已有实现，本报告PR没有修改这5个文件。
