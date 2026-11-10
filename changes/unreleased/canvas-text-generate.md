## 用户

- 画布能用「文字生成」节点了：写一句话让模型帮你写或扩写提示词，连上图片还能看图写描述（要选能看图的型号，选得不对节点上会提示）。生成的文字能接给下游节点，也能另存成文本节点或存进提示词库。

## 开发

- 画布完善第 6 条：主进程能跑文字生成节点（`text-generate`），打开 `desktopCanvasCapabilities.features.textGenerate`，`executableNodeKinds` 加上它（`canvas-contract.ts` 和 `canvas-preload.ts` 两份一起改）。内核不用改，桌面原来只是把这类节点标成「桌面版暂不支持」。
  - 做法跟 xingmang-canvas 网页版服务端一样：上游文字和节点自己的提示词按行拼成一条用户消息，不加系统提示，走聊天服务的 `completeOnce`（同一套超时、并发、实扣记账）；结果超过 32000 字不收（画布项目存文字结果的上限）。
  - 连了图片：型号只认内核确认过能看图的 6 个，最多 4 张、单张 4 MB、合计 8 MB，像素和边长也有上限（新文件 `canvas-text-image-input.ts`，跟内核对拍）。图在凭据认出账号以后、发请求之前从这个账号的项目素材库读（`CompleteAiChatOnceInput.readImages`），读不到或超限就不发、不扣钱。
  - 联网搜索（`textWebSearch`）仍然关着，节点开了联网搜索照旧在付费请求前拒。
