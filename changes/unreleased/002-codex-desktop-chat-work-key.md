## 用户

- Codex 桌面端发消息报「提交消息时出错」的办法写进了教程：在 Codex 桌面端（也叫 ChatGPT）的「聊天」「工作」里报这句、还带一句 Work browser access requires an authenticated account 的，是那两项要登录 ChatGPT 账号；用当前账号时请在窗口左侧栏最上面把模式切到「Codex」再发。新手引导里也写明了这一步，在教程里搜这句英文能找到办法。

## 开发

- 客户报：ChatGPT 桌面端（合并了 Codex 的那一版）的「聊天」「工作」由 ChatGPT 账号协调（Work 设置、
  浏览器权限都在 chatgpt.com 那边），OpenAI 文档列明用 API Key 登录时 ChatGPT Work 不可用；我们写的是
  中转密钥，只有「Codex」那一栏走得通。只改说明：`registry/tutorials.ts` 新手教程第 4 步、「打开 Codex
  后怎么开始用」第 2 步、「出问题怎么办」新增一步（首页落点，Linux 版按 page 过滤）；`guide-result.ts`
  新手引导最后一步在用密钥的桌面端上提示先切到「Codex」。不改 Codex 配置，不隐藏「聊天」「工作」。
