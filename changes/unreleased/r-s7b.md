## 用户

- 工具检测失败时，首页工具行和外部客户端行显示的失败原因不再带出本机路径和电脑用户名。

## 开发

- R-S7b：`src/renderer-v2/business-common.tsx` 新增 `snapshotErrorMessage`，把主进程快照里的
  `detectionError` / `configurationError` 接到 R-S7（#160）的脱敏入口 `userFacingErrorMessage`；
  `features/tools/model.ts` 与 `features/tools/external-model.ts` 两个展示层改为经它取值，
  原有中文兜底文案（「工具检测没有完成」、版本/安装提示）不变。
