## 开发

- Codex 复核 M03（#1905 核实为一般，即 YKS-4 当时没做的后半）：手机遥控一轮做完、最后那条回答发不出去时
  （`sendText` 吞掉错误，飞书、微信自己的重发也没成），以前这一轮照样记成做完，回答哪儿都不留，手机上发「状态」
  取不回，发「重试」让 Codex 从头再做一遍。现在 `sendText` 返回整段送没送到；做完的回答走 `sendAnswer`，没送到就在
  `ChannelRuntime.undeliveredAnswer` 留一份（只在内存，给原来那个人，最多 24 小时，关遥控、换人、解绑时扔），
  日志记 `remote.answer-undelivered`。两处补发：渠道状态从别的变回 connected 时（含「重新连接」），以及绑定的人
  发来任何一条时先补再处理（这时有一轮在做就不等补发发完，「停止」「同意」不往后排）。发的是「重试」而补的正是
  最后一句的回答，只补发、不再交给 Codex，补发后跟一句怎么真重做；之后又交过新的一句（`latest` 变 false）就照常重做
  新的那句。补发时先从 runtime 上摘下再发，正在补发时再叫一次等同一次（`answerResend`），连上了和手机来消息碰在
  一起只发一遍；还是没送到就放回去，成了记 `remote.answer-resent`。新加手机上两句 `answerResent`、
  `retryAfterAnswerResent`。没做完、被停下的那几句不留。
