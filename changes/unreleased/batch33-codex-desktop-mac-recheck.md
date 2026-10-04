## 用户

- Mac 上「应用程序」里已经装好了 ChatGPT（Codex 桌面端）时点「安装」，星芒那一刻要是还没检测完，会再检测一次，
  认出来就照常提示「Codex 桌面端已经装好了，不用重复安装」。以前这种情况会把正版说成「不是官方原版」、叫你移到废纸篓。

## 开发

- 第三十三批 D（0.2.15 发版前回归检查建议 g 的前一半）：`electron/codex-desktop-service.ts` 的 `installCodexDesktopOnMac`
  第一次检测没做完（`detectionFailed`，或者检测本身抛错）时再检测一次，认出来就照已装好的那条路结束，不下载。以前没做完
  和「查过了，没装」一样往下走，`installMacosDesktopApp` 看到「应用程序」里有 ChatGPT.app，只认得出旧版聊天程序
  （com.openai.chat），正版 com.openai.codex 也落到「不是官方原版」那句。
- 第二次还没做完就照旧往下走，不一律停下：`detectionFailed` 也包括 Spotlight 查不了、扫应用目录超时这类和 ChatGPT.app
  无关的情况，停下会让这些 Mac 再也装不上。两次都没做完、「应用程序」里又是正版时照旧说错，要新写一句话，留作跟进。
  第一次检测期间客户点了「取消」就不测第二次，直接按取消收场。
- 沙箱用真的 `createCodexDesktopService`（darwin）和真的 `installMacosDesktopApp` 演过（「应用程序」换成临时目录，里面放
  plutil 读出 com.openai.codex 的 ChatGPT.app，第一次检测给签名核对超时）：改前说「不是官方原版」；改后第二次认出来时
  提示已经装好、安装器一次都没调，第二次也没做完时和改前一样。
