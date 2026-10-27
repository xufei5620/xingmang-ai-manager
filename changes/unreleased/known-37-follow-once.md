## 开发

- 换账号同步到 Claude Code、Codex 时，保存配置后台替外部客户端跟换密钥的那一眼合成一轮
  （`external-client-route-service.ts` 的 `followManagedKeysNow`）：以前两家各跑一轮，后一轮在前一轮换完之前就记下计数，
  界面重读两次，#1413 加的用例在 Mac CI 上偶发红。现在跑着时再叫只记一笔「跑完再看一遍」，后一家的密钥照样跟上，
  只叫界面重读一次。`external-client-service.test.ts` 加一条把两轮卡在一起的用例，拿掉修复会红。
