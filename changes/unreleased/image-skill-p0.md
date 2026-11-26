## 用户

- 在 Codex 等 AI 工具中画图后，图片会保存为文件并给出文件位置，对话中只显示一张小预览图。
- 余额不足时画图会立即停止并提示充值，不再反复重试。
- 未安装 Node.js 的电脑，画图工具可改用 Codex 桌面端自带的运行环境。
- 画图失败时的提示更明确，AI 不再自行反复尝试其他方式。

## 开发

- 画图技能优化需求的六条 P0（A1 A2 C1 D1 D2 D3），细节见 `docs/NATIVE-IMAGE-MCP.md`。
- C1：画图工具（`bundled-skills/xingmang-ai/scripts/mcp-server.mjs`）不再把原图放进工具结果。原图存成新文件（工作目录的
  `outputs/`，没有工作目录时是系统图片文件夹里的「星芒AI」，再不行是临时目录；文件名带时间和型号，`wx` 方式打开、不覆盖），
  结果里只放一张最长边不超过 1024、不超过 300KB 的预览（不透明用 JPEG，透明底用 PNG）和一段固定文字。起因是新版 Codex
  桌面端（0.171 起）把约 1MB 以上的图片显示成 JSON 原文，且原图会跟着对话历史每轮重传。缩小和编码在新文件
  `scripts/image-preview.mjs`（纯 Node，PNG 解码、区域平均缩小、基线 JPEG 编码、PNG 编码），已加进
  `XINGMANG_AI_BUNDLED_FILES`。保存位置只由脚本决定，工具没有 `out` 参数。`size` 写了宽高又传 `aspect` 时比例一致不再报错
  （两个脚本都改）。`SKILL.md` 给 Codex 一段照抄的调用代码，「完成后」补上画图工具这条路。
- D1：两个脚本认出余额不足（`insufficient_user_quota` 和那几句原话，同 `relay-quota-failure.ts`）就只发一个请求，回带金额的一句话；
  密钥自己的上限用完照旧换另一把。
- D2：换型号只在型号现在用不了时（404、`model_not_found`、`model_price_error`、无可用渠道、No available compatible accounts）；
  点名的 gpt-image 型号用不了时也改用默认那一串（以前只用它、原样报错），点名 Nano Banana、Grok 的不换；
  换密钥只在 401、429、503 和余额不足以外的 403；网关错误、连不上都不换。换了型号在结果里说明。
- D3：`generate.mjs` 请求没发出去就失败时打固定诊断、退出码 3；已发出没等到回复的按可能已扣费处理，退出码 1。`SKILL.md` 加
  「失败时」一节，删掉「没有 Node 时再手写请求」；`references.md` 开头写明只是接口说明。
- A2：`SKILL.md` 的 description 和正文写明画图工具在 Codex、Claude Code 里的完整名字，以及没看到时先按 `xingmang` 搜一次全部工具。
- A1：登记画图工具时找不到系统 Node 就用 Codex 桌面端自带的那份（`xingmang-ai-mcp.ts` 的 `resolveXingmangImageNodeExecutable`）。
  没有用 `ELECTRON_RUN_AS_NODE`：发布包的 RunAsNode 熔丝是关的，不为这件事打开。开机补登记原来就有（恢复登录时会走到
  `syncImageMcp`），没有另加；卸载时清登记没做。
- 测试：`scripts/xingmang-image-mcp.test.cjs` 起画图工具时给它单独的工作目录和主目录；品牌门禁放行 `mcp-server.mjs` 里图片文件夹名
  那一处；三条旧用例的期望跟着 D2、C1 的新规则改了（网关错误不再换型号；点名的 gpt-image 型号用不了时改用默认那一串；
  `size` 与 `aspect` 一致不再报错）。
