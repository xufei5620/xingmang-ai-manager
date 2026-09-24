## 用户

- 画布点「停止」后不会再发出新的生成请求，也不会因此扣费。以前如果停止刚好落在节点开始运行的那一瞬间，请求还是会发出去。

## 开发

- #484（审计 D10）：`canvas-run-engine.ts` 在 running/submitting 落盘之后、调用 executor 之前，再检查一次是否已取消；`canvas-node-executors.ts` 的 image、image-edit、video 三个入口对已经 aborted 的 signal 直接拒绝。原因是 `addEventListener('abort')` 对已经取消的 signal 不会触发。两处都补了测试，去掉修复后测试会失败。
