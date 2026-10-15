## 开发

- UI v4 批13 聊天（`features/chat/ChatPage.tsx`、`chat.css`）：会话栏 236、搜索常驻、`groupConversationsByDay`（`state.ts`）按本地日历
  分「今天 / 昨天 / 更早」，条目写「N 条消息」/「正在回答…」，「…」菜单只留「导出这段对话」「删除这段对话…」，底部「清空全部对话」
  （`useChatController` 的 `clearAllConversations`，有对话在生成时不让点）；页头加「导出这段对话」。
- 分组和模型两个下拉框并成一个 `ChoiceMenu`（`ui/floating.tsx` 新组件，`align='start'`，分组那组选完不关）：分组列后台的分组名、
  说明用后台 `description`（和名字一样时不重复），下面是这个分组的模型和「N 个模型可用」，底部「刷新分组和模型」走
  `refreshGroupsAndModels`（先刷分组再准备当前分组，刷完提示可用模型数）。按钮带 `data-group` / `data-model` / `data-preparing`，
  沿用 `chat-model` 这个 testid；分组项、模型项在 `chat-group`、`chat-model-options` 两组里，刷新是 `chat-group-prepare`。打开菜单
  照旧只触发一次后台刷新分组（`refreshOnInteraction`）。画图的尺寸、画质、分辨率也改成同样的小菜单，加「画质：自动」。
- 参数从弹出层改成对话框（`ParametersPanel.tsx` 改名 `ParametersDialog.tsx`），带「没保存」确认条，点「应用」才写回；随机度、采样范围、
  两个惩罚改成 `Slider`（`ui/fields.tsx` 新组件），空值 = 不发；整数项填了小数时说「要填整数」。命令面板加「聊天参数设置」
  （`command-search.ts` 的 `chatParametersSection`，App 收到后把 `openParameters` 交给聊天页）。
- 断网时发送的提示换成聊天自己的「没发出去：…点「重试」」，横幅上的「重试」用上次那次发送的参数再发；`online-status.ts` 的共用句子没动。
- 消息：自己发的靠右、无头像、按钮悬停出现（复制 / 编辑后重新发送 / 删除消息）；回答不带气泡、按钮常驻（复制回答 / 重新生成 / 删除消息）；
  代码块头上写语言（取 `language-xxx`，没有写「代码」），复制代码提示「代码已复制」。计费小字去掉「服务端」三个字，跟「回答由模型生成…」
  同一行。切走聊天页时输入框那排菜单和对话「…」菜单重新挂一遍，开着的弹出层跟着收起。
- 教程「直接聊天与生成图片」第一步和配图说明里的「输入框上方」改成「输入框底部」；`registry/pages.ts` 聊天页的搜索词加「分组」「模型」，
  分组和模型挪进菜单以后顶部搜索照样找得到。
