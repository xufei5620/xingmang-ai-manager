## 开发

- 手机遥控的用例文件 `electron/codex-remote-service.test.ts` 不再用 `vi.waitFor` 等写盘后面的事：帮手 `prompted()` 等
  `turn/start` 默认只等 1 秒，每句话交给 Codex 前要先原子写一次消息编号，Windows runner 写得慢时 #1949、#2038 各红一次。
  临时给原子写计数，找出等待期间写过盘的 74 处，全换成等事件本身（起 Codex、交出请求、发到手机、开始取图、推状态、删图），
  `FakeCodex.requestedUntil` 改成当场回了才 resolve。每次写盘人为拖慢 1.1 秒时，旧写法 85 条因 1 秒等不到而红，新写法 0 条。
  没调超时，没跳过测试。
