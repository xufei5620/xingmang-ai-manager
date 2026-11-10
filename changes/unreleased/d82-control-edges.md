## 开发

- D82：两套默认配色里输入框（`.xm-field`、`.xm-search`、下拉选框、聊天输入框）和次要按钮的边从原型的
  1.3～1.4 : 1 加深到对底色 3 : 1，悬停再深一档（以前悬停用 `--line-3`，加深后会比平时还淡）。值只写在
  `src/renderer-v2/styles/tokens.css`，`ui-spec/tokens.css` 仍是原型；新增 `--input-line-hover`、
  `--btn-2-line`、`--btn-2-line-hover`，高对比度两套给了跟以前一样的值。`contrast-tokens.test.ts`
  加默认两套的检查：三级文字 4.5 : 1、按钮和状态文字 4.5 : 1、焦点环和开关 3 : 1、这两种控件的边 3 : 1
  且悬停不变淡；高对比度「每个令牌都盖住」那条也把新令牌算进去。出处：键盘无障碍.md KB-15。
