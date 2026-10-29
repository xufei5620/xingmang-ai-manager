## 开发

- 手机遥控：Windows 上在星芒里更新、卸载 Codex 之前先让遥控放开它那份 Codex（#1407 P3-3 的后一半，yoyo 10-29「按推荐」）。
  手机用过一次以后 `codex app-server` 一直开着，锁着自己的程序文件，npm 换版本、挪包目录都撞上 EBUSY，提示里看不出是遥控占着。
  现在装、卸的那一项排到安装队列里以后，先调 `CodexRemoteService.releaseCodex`：闲着就停掉、等它真退出（最多 10 秒，等不到照常往下，
  撞上占用时还是原来那句「文件被占用」），手机下次来消息再起一份、从新对话开始；这一轮没做完、有等着同意的、还在起的，都不动它，
  直接报「手机遥控里的 Codex 正在干活，等它做完再更新（卸载），或者先在设置里关掉手机遥控。」，一个字节都不动。
  平台和工具的判断在 `system-service-context.ts` 的 `releaseRemoteCodex`（只管 Windows 上的 Codex），`main.ts` 等遥控建好再接上。
  `CodexAppServerClient` 加 `whenExited()`；刚关掉遥控、还没退干净的那份也一起等。
