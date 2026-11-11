## 开发

- 修 Windows CI 上 `node-runtime.test.ts`「gives up at the ceiling and removes the partial package」偶发红
  （`expected 760000 to be 1800000`）：它自己的 `driveChunkByChunk` 以前每格最多等 1 万轮让那一块落盘，写盘慢时
  照样拨假时钟，3 分钟没进展那道比 30 分钟兜底先到。现在跟 `slow-download.test-support.ts` 一样，有文件操作在进行的
  轮次不算数；被测代码和断言没动，同文件新增一条在旧写法上会红的用例。
