## 开发

- 软件自带教程跟上 0.2.22：聊天那章不再教「选好分组」（#1399 以后聊天只选厂商和模型），生成图片那步、
  聊天插图同步去掉分组；更新那章不再说「不打断你」，改成下好后跳框问装不装（打磨 B1 漏掉的第三处）。
  聊天出错提示里「更换可用分组」「准备分组」两处改成充值、重新登录后重试。`registry/tutorials.ts`、
  `features/tutorial/TutorialIllustration.tsx`、`features/chat/state.ts`，测试钉住教程不再叫客户选分组。
