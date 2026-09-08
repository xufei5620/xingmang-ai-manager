# 桌面聊天

`ChatPage({ bridge: XingmangApi, accountScope: string, active?: boolean })` 使用原型聊天专用结构：220px 会话栏、顶部当前会话、独立滚动消息区和底部输入区。父级应提供无额外 padding 的内容空间。

同一账号内保留组件挂载并以 `active={false}` 暂时隐藏：后台请求、会话与草稿继续保留，隐藏时不处理输入快捷键且移除顶层弹窗和菜单。账号改变仍按 scope 重建并取消旧请求。根节点的 `data-busy`、`data-unsaved` 供原生窗口关闭检查使用，隐藏页面也继续暴露这些状态。

所有 IPC 都封装在 `api.ts`。该文件只复用 `electron/ai-chat-protocol` 已验证且无 Node 依赖的模型能力与请求校验函数，不修改协议，不依赖旧渲染层。

已实现：

- 分组列表、准备与重试；按主进程规则过滤隐藏和不可用模型，保留图片尺寸、画质、分辨率以及自定义尺寸。
- 文本、思考与 Markdown 输出；停止、复制、编辑重发、重新生成、删除消息、清空及删除会话。
- 每个会话独立保存参数、系统提示词、草稿、模型和分组。重试使用原请求快照，不重复添加用户消息；编辑重发移除依赖旧消息的后续内容。
- 图片真实生成、预览、复制、另存和主进程原生菜单。另存取消不会提示成功。
- 图片取消前确认费用风险，取消回执为 `mayStillComplete` 时继续显示可能计费的说明，再次生成需要明确确认。
- 账号 scope 切换重建控制器、取消旧请求并拒绝旧事件和图片回包；单会话同时一个请求，窗口内最多四个并行请求。
- Enter / Shift+Enter 与中文输入法组合阶段隔离，剪贴板失败可手动复制。

记录保存在 `xingmang-ui-v2:chat:<scope>`，不包含运行时素材 URL 和请求 ID。读取时只重建合法的本机素材协议地址，未完成消息降为已停止。无法读取的记录保留原始值，并持续说明当前会话不能保存，避免悄悄覆盖损坏数据。

若完整 scope 以 `:<userId>`、`/<userId>` 结尾或本身等于 userId，且旧记录 owner 与当前已验证账号一致，会无损导入旧 `xingmang-ai-chat:v1:<userId>` 记录；旧 key 保留。

验证：

```powershell
npx vitest run src/renderer-v2/features/chat/state.test.ts --no-file-parallelism --testTimeout=30000
node --test src/renderer-v2/features/chat/browser-check.mjs
```

浏览器测试只访问本地 fixture，所有非回环网络请求被拦截。暗/亮 × Win/Mac × 默认/空/失败截图及图片结果截图位于 `.project-surgeon/audits/20260907-chat-v2/`。这是浏览器平台展示矩阵，不替代 macOS 原生验收。
