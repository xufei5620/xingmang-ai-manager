## 开发

- UI v4 批01 底座：`ui-spec/tokens.css` 换成 v4 两套配色（黑金深色、晨曦金浅色），加 v4 语义变量
  （`--pri`、`--gold`、`--focus`、`--pop`、`--toast`、状态文字 `-tx` 等）；高对比改成每套主题一整套值，
  `contrast-tokens.test.ts` 加查它覆盖了主题的每个变量、状态文字 4.5:1、焦点环和输入框边 3:1。
  主窗口不再设 `data-skin`，设置里的 `uiSkin` 字段照旧存（删了会被当成第一次启动），皮肤规则只留给画布。
- 缩放下限：自动倍率 0.9、最终倍率 0.85（`UI_AUTO_MIN_ZOOM` / `UI_MIN_ZOOM`，`e2e/renderer-v2-native.mjs`
  的副本同步）。
- `ui/modal.tsx`：标题去掉图标，副标题挪到标题下面一行；有修改时关闭不再整块换成确认页，表单留着、底部换成确认条，
  条在时再关会抖一下。Esc 改在 keydown 上处理：Chromium 连按几次 Esc 后 `cancel` 事件不能再拦，`<dialog>`
  会绕过 React 自己关掉，草稿丢了、调用方还以为开着。
- `ui/feedback.tsx` 短提示挪到右下角、带图标；`ui/guidance.tsx` 导览气泡宽 264、带箭头、给目标描金边，
  侧栏两步放在目标右边（`registry/shell.ts` 的 `placement`）。
