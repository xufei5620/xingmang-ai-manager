## 用户

- 「创作」起始页新增「图片生成」「视频生成」「智能对话」三个入口，点击即可开始；下方入口改为「进阶创作」，包括「分镜视频」「无限画布」「片段合成」。

## 开发

- 创作页起始页入口改成功能名（yoyo 11-28 回「功能名入口」，全面方案第 30 件方案甲）：`features/chat/ChatPage.tsx` 加 `ChatStartModes`（标题说明下面一排三个按钮，`aria-pressed` 跟输入框下的 `chat-mode` 同一个值，点了 `selectMode` 并把光标放进输入框，已是这一档只放光标；`videoReady` 为假时不出视频那一个）。三档名字收进 `state.ts` 的 `chatModeNames`（智能对话、图片生成、视频生成），输入框下的切换、起始页入口、「用此图生成视频」的悬停字、带文件时的两句提示都读它；入口的关键词和先后在 `chatModeKeywords` / `chatStartModes`。`features/create/CreatePage.tsx` 的 `CreateStartCards` 分组名改「进阶创作」，卡名改「分镜视频」「无限画布」「片段合成」、说明改关键词，`StartCard` 多一个 `opens`：只有另开窗口的画布卡角标前带往外的箭头。教程（`registry/tutorials.ts`、`TutorialIllustration.tsx`）和视频剪辑出图框副标题（`ShotImageDialog.tsx`）里引用旧名的跟着换，`CreatePage.test.tsx` 另钉住教程里不再留旧卡名。有「已合并至此页」提示时入口的留白和图标随窗口高度收得更狠（`create.css`），1280 × 680 卡下面还剩约 48 像素。第一次打开默认停在哪一档没动（照旧智能对话）。
