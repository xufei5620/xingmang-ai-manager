## 开发

- 测试：`electron/ai-video-service.test.ts` 里用真 `AiVideoTaskStore` 的四条用例（发请求前先记「结果不明」、两单抢最后一个名额、提示词随任务记下、关掉再开接回同一单）原来用 `vi.waitFor` 等假 fetch 被调到或任务记进盘，默认只等 1 秒；中间隔着一到两次带刷盘的原子写，#1536 的 `windows-test (vitest-2)` 在「关掉再开」那条撞过。改成等事件本身：假 fetch 在付费请求发出时 resolve 一个 Promise，记任务的两条等「处理中」那一刻（任务记进盘后才报）。断言照旧，不调超时，产品代码不动。
