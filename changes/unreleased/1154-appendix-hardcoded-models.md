## 开发

- 配置窗口挑默认型号也看服务状态文件里的型号表了（#1154 附录，#1059 残留）。以前只有登录自动配置看它：远端换了默认，
  从配置窗口给没设型号的工具配，预选的照旧是程序自带的默认，检测完替他挑、保存后核对也不看远端的上一代和下架名单。
  现在新加只读通道 `tools:cli-model-hints`（不带入参，读不到给 null，不进账号那道闸），`ConfigDialog.tsx` 打开时读一次，
  预选用 `cli-model-defaults.ts` 新的 `resolveCliModelDefault`，`resolveDefaultCliModel` 两处都带上型号表。读到之前、读不到照旧用自带的。
- Codex「换用别家模型」（`OtherModelsDialog.tsx`）里那条「Codex 默认」也跟着型号表走，跟模型列表一起读。
- AI 对话的默认文字型号 `gpt-5.6-sol` 不在分组里（下架了）时，改挑同系列版本最新的（新的 `resolveDefaultChatModel` /
  `resolveNewestModelOfFamily`），不再按字母序退到第一个（以前 `gpt-5.4` 排在 `gpt-6.1-sol` 前面）。同系列也没有才照旧取第一个；
  图片模式不变。`gpt-5.6-sol` 还列着时什么都不变。
- 没改的：主进程画布执行器生图分组为空时兜底写死 `'图片模型'`（`canvas-node-executors.ts`）。画布运行前已经拦下没选生图分组的
  情况（`canvas-v2/src/runtime/run-preflight.ts` 的 `canvasMediaConfigurationErrors`），这句兜底正常走不到；要改只能改成报错，得新加一句提示。
  连接自检在工具配置里没写型号时用自带默认（`connection-check.ts`）也没接型号表。
