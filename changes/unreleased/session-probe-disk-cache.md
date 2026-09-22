## 用户

- 第二次打开起首页「最近」记录更快：会话记录的探测结果会存在本机，文件没变就不再重新读一遍对话文件。

## 开发

- 新增 `electron/provider-session-probe-cache.ts`：把 `ProviderSessionsService` 原本只在内存里的
  `probeCache` 落到 `userData/sessions/probe-cache.json`，键仍是会话文件的
  `size:mtimeMs:ino`（grok 另计 `summary.json` 的那一份），命中直接用缓存、变了才读前 512 KB。
- 缓存只存探测出来的元数据（标题、目录、模型、时间、条数、首条提问），不存任何对话正文；
  读回时逐字段校验并截断超长文本，版本号不符、JSON 损坏或读取失败一律整体作废后静默重建。
- 写入走 `safe-local-data` 的原子写，且在 `list()` 返回之后异步进行，不阻塞首页；
  条数上限沿用 10000 条 LRU，落盘另有 2 MB 上限，超出时丢最早的那些。
- 一次完整扫描某个 provider 目录后，会把该目录下已经不存在的会话从缓存里删掉。
- 沙箱实测：400 个约 208 KB 的 Claude 会话文件，第一次 `list()` 读 83112000 字节，
  第二次读 0 字节，缓存文件 271916 字节。
