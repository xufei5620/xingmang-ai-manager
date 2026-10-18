## 开发

- 新增零依赖的 `electron/input-guards.ts`（`isRecord`、`isStringArray`、`filterStrings`、`isPromiseLike`），
  主进程和渲染层都能用，已登记进 `verify-renderer-boundary` 的值导入名单。新代码从这里取；旧文件里各自写的
  四十多份等拆分时（#1070）顺手换，本次不批量替换（#1071 第 3 条）。
