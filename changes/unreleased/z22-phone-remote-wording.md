## 开发

- 0.2.24 深查改字批次 Z22（D65、D67）：手机遥控卡片的「解绑」「退出登录」改成先弹 `Confirm`（`CodexRemoteCard.tsx` 的 `codexRemoteConfirmText`），确认后先关框再执行，失败原因仍在卡上的红条里；微信扫码登录好以后那句按卡片快照里有没有 `boundPeer` 分两种（`WeixinRemoteSection.tsx` 的 `weixinLoginHeadline` 多一个参数）：没绑人先指去「打开遥控」再配对，扫的还是原来那个机器人、绑定的人还在就说不用重新配对。用户行由协调者统一补。出处：手机遥控.md YKS-7、通知弹窗.md NT-8。
