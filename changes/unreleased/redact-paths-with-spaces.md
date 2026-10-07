## 用户

- 出错时屏幕上的原话和「复制给客服」复制出去的内容里，账户名或文件夹名带空格的路径也整段藏起来，
  不再露出账户名的后半截。

## 开发

- `src/renderer-v2/business-common.tsx` 的 `userFacingErrorMessage`：脱路径以前到第一个空格就停，
  `C:\Users\Zhang San\.claude\settings.json` 上屏成 `本地配置文件 San\.claude\settings.json`（I13）。
  现在空格后面还有分隔符就接着算路径；文件夹名里不收 Windows 禁用的文件名字符、引号和断句标点，
  吞不进后面的句子和下一个带引号的路径；最后一节照旧到空格为止。只在原来的基础上多换、不少换。
  旧回滚界面 `src/error-message.ts` 已冻结，没动。
