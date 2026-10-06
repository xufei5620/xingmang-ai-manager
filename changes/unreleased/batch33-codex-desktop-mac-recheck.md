## 用户

- Mac 上「应用程序」里已经装好了 ChatGPT（Codex 桌面端）时点「安装」，星芒那一刻要是还没检测完，会再检测一次，
  认出来就照常提示「Codex 桌面端已经装好了，不用重复安装」；两次都没检测完，就提示「Codex 桌面端检测未完成，请重新检测后再试」。
  以前这种情况会把正版说成「不是官方原版」、叫你移到废纸篓。

## 开发

- 第三十三批 D（0.2.15 发版前回归检查建议 g 的前一半）：`electron/codex-desktop-service.ts` 的 `installCodexDesktopOnMac`
  第一次检测没做完（`detectionFailed`，或者检测本身抛错）时再检测一次，认出来就照已装好的那条路结束，不下载。以前没做完
  和「查过了，没装」一样往下走，`installMacosDesktopApp` 看到「应用程序」里有 ChatGPT.app，只认得出旧版聊天程序
  （com.openai.chat），正版 com.openai.codex 也落到「不是官方原版」那句。
- 第二次还没做完就照旧往下走，不一律停下：`detectionFailed` 也包括 Spotlight 查不了、扫应用目录超时这类和 ChatGPT.app
  无关的情况，停下会让这些 Mac 再也装不上。第一次检测期间客户点了「取消」就不测第二次，直接按取消收场。
- 两次都没做完时告诉安装那一步（`installMacosDesktopApp` 新加的 `detectionUnfinishedMessage`）：「应用程序」里占着名字的那份
  自称 com.openai.codex，就报现成的「Codex 桌面端检测未完成，请重新检测后再试」（和 Mac 上点「打开」时检测没做完同一句），
  不说「不是官方原版」、叫客户移到废纸篓。只换说法，照样不装、不动它；旧版聊天程序、别的 bundle id、读不出来的照旧，
  检测做完了还没认出来的那份也照旧说不是官方原版。
- 「没做完」只算没查完的：`detectionFailed` 以前把两种情况混在一起，`inspectMacosCodexApp` 新加 `rejected` 分开。自称是 Codex 的
  那份核对下来确定不过关（codesign、plutil 跑完了退出码非 0，可执行文件缺了、不是能跑的 Mach-O、类型权限不对、架构不兼容）
  时带上它，安装那一步照旧说不是官方原版，再测几次都一样，客户得知道要把它挪走；命令超时、没起来，文件读不了，问不出这台 Mac
  跑什么架构，才算没查完。`detectionFailed` 本身和首页的显示都没变。
- 沙箱用真的 `createCodexDesktopService`（darwin）和真的 `installMacosDesktopApp` 演过（「应用程序」换成临时目录，里面放
  plutil 读出 com.openai.codex 的 ChatGPT.app，第一次检测给签名核对超时）：改前说「不是官方原版」；改后第二次认出来时
  提示已经装好、安装器一次都没调。两次都没做完的那种由 `codex-desktop-service.test.ts` 用真的安装函数钉住。
