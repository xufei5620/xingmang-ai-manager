## 用户

- 在 Codex 等 AI 工具中画图时，图片将保存为文件并给出完整位置，对话中仅显示缩小后的预览图。
- 画图遇到余额不足或无法联网时，将立即说明原因并停止，不再反复尝试。
- 已安装 Codex 桌面端的电脑无需另装运行环境即可画图；登录后再安装 Codex 的，重新打开星芒即可自动启用画图工具。

## 开发

- 画图技能优化 A1：画图工具的 Node 先找电脑上自己装的，没有再用 Codex 桌面端自带的
  `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node`（`xingmang-ai-mcp.ts` 的
  `resolveXingmangImageNodeExecutable`）；开机装完技能文件后，已登录的电脑补登记一次（`main.ts`、
  `resolveXingmangAiImageMcpSkillDirectory`）。需求里的 `ELECTRON_RUN_AS_NODE` 没做：发布包的 RunAsNode
  fuse 是关的（`electron-builder.config.cjs`），要不要另想办法等产品所有者定。
- 画图技能优化 A2：`SKILL.md` 写明 Codex、Claude Code 里画图工具的完整名字和搜法，`description` 里写「优先调用画图工具」。
- 画图技能优化 C1：`mcp-server.mjs` 把原图存成新文件（默认「图片/AI图片」，可传 `out`；`wx` 打开，从不覆盖已有文件；
  写不进依次退到默认位置、临时目录，都不行才把原图放回对话），结果里给完整路径和宽高，对话里只放
  最长边 768、不超过 200KB 的 JPEG 预览。预览由新的 `scripts/image-preview.mjs` 用 Node 自带的 zlib
  解 PNG、区域平均缩小、基线 JPEG 编码，不加依赖；工具说明和 `SKILL.md` 不再说「直接显示在对话里」。
- 画图技能优化 D1、D2：两个脚本统一按 `classifyRelayFailure` 决定下一步：余额不足（`insufficient_user_quota`、
  「额度不足」「预扣费额度失败」）立刻停，给出带金额的一句话；只有型号用不了（404、`model_not_found`、
  无可用渠道、没定价）才换型号；401、429、503 和余额以外的 403 才换 Key；连不上网络不换 Key。
- 画图技能优化 D3：`generate.mjs` 连不上网络时退出码 3 并给出中文诊断，回复读到一半断开时说明可能已扣费；
  `SKILL.md` 删掉「没有 Node 时手写请求」和「你可以改这个技能」，加「失败时」一节；`references.md`
  开头写明只是接口说明。
