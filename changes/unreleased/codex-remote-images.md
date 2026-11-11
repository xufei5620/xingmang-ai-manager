## 开发

- Fable 手机遥控 YF-14：手机上能发图片（yoyo 2026-11-11「图片改」，微信那半另有他亲手打的「微信图片网址加」）。
  渠道把图交成 `RemoteInboundImage`（只带取图句柄，底座不解读、不进日志），底座核过是绑定的那个人才调渠道的
  `fetchImage(ref, maxBytes)` 去取：陌生人发的图连下载都不下载。取回来的按开头字节认 PNG、JPEG、GIF、WebP，经
  `codex-remote-images.ts` 用随机文件名原子写进 `<userData>/codex-remote/images`（I8），攒着等下一句话，一起作为
  `{ type: 'localImage', path }` 放进 `turn/start`；最多 5 张、每张 10 MB。只有图时回一句「收到图片」，取不到、太大、
  飞书没开权限、攒满了各回一句。上一句带过的图留给「重试」，下一句交出去、关遥控、换人时删；「新对话」只扔攒着的；
  全关和退出时整个目录清掉，下次打开遥控先清一遍。
  飞书走「获取消息中的资源文件」（`GET /open-apis/im/v1/messages/:id/resources/:key?type=image`，只去 `open.feishu.cn`），
  要「获取单聊、群组消息」权限，建机器人第 3 步跟着加上；99991672 / 99991679 报没开权限，234037 报太大。微信照
  openclaw-weixin 从 `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=…` 取、AES-128-ECB 解开，
  `weixinCdnOrigin` 是遥控能连的地址里新加的唯一一条，消息里带来的 `full_url` 一律不用。微信取图是照两份开源接入推的，
  要真机核。`codex-remote-http.ts` 抽出 `requestRemoteBytes`，跟 `requestRemoteJson` 共用同一套四件（I10）。
  用户行并在 `codex-remote-fixes-0224.md`。
