## 用户

- 画布提示词里写网址或本机路径不再让整次运行白跑：以前提示词中出现一个网址，图或视频生成完、额度也扣掉之后才报「运行记录持久化失败」，记录一条都不留；现在任何文本都能正常存下并原样显示。

## 开发

- `canvas-run-store.ts` 的 `stateContainsSecretOrPath` 原来扫整份序列化内容，而 `text` /
  `prompt` / `note` 执行器返回的就是用户敲进去的文本（`canvas-node-executors.ts:113`），
  原样进 `attempt.outputText`，于是 `/https?:\/\//i` 与 `/(?:[A-Za-z]:\\|file:\/\/)/i` 命中用户
  自己的内容，`writeState` 每次都抛，`canvas-run-engine.ts` 在付费生成之后才抛给用户；读路径同样
  把这种文件判为损坏并清空运行历史。新增 `stateScanSubject`，用 `JSON.stringify` 的 replacer 把自由
  文本字段（`outputText` / `errorMessage`）从被扫描的那份序列化里剔掉，写盘内容不变，资产引用、各类
  标识、`mimeType`、`taskId` 等结构化字段仍然拒收凭据、远端地址与本机路径；读路径改为先 `parseState`
  再对同一份投影断言。未对用户内容做脱敏改写——该字段会经 `storeCache` / `resolveCache` 喂给下游节点，
  改写它会让命中缓存与未命中缓存产出不同的提示词（审查总表 E-S6）。
