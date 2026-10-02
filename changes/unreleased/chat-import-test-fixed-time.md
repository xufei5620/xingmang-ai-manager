## 开发

- `src/renderer-v2/features/chat/storage.test.ts`「merges into the saved files and survives a reopen」偶发红：夹具连着建的两个对话都取 `Date.now()`，偶尔跨过一毫秒，后建的那个 `updatedAt` 更大，导入按 `updatedAt` 倒序排就排到了前面。夹具和导入对话的时间改成写死的值，断言不变。产品代码没改：排序是稳定排序，同一毫秒的对话保持原来的先后。
