## 用户

- Codex 桌面端的语言说明里写明了：中文界面要从星芒打开 Codex 才有，直接点 Codex 自己的图标打开是英文。

## 开发

- Codex 桌面端的中文要 OpenAI 下发的 `enable_i18n` 开关，Codex 每次冷启动头几秒才拉；星芒只在自己「打开」的那一下帮它拿到
  （两个系统都先连加速，Windows 选过「显示中文」的再走本机调试端口补丁，`codex-desktop-cdp.ts`），开机后从开始菜单、任务栏、
  程序坞直接打开拿不到，`config.toml` 的 `localeOverride = "zh-CN"` 单独不管用，界面是英文。以前界面上没说过这一点，客户会以为
  汉化掉了。上游同一现象见 openai/codex#50377（26.930.2377.0，启动时开关没拿到，简体中文设置还在、界面成了英文）。
- 只改文字，三处：`App.tsx` 第一次打开 Codex 的「要让 Codex 的界面显示中文吗？」询问框第一段末尾加一句；`ConfigDialog.tsx` 的
  「界面语言与文件夹权限」Windows 第一段、`locale-status.ts` 的 `macLocaleNote`（Mac 那段）各在开头加一句；`registry/tutorials.ts`
  「出问题怎么办」里「能打开，但还是英文？」先说从哪打开，再说「检查中文界面」。不动启动逻辑、加速和本机通道。
- 测试：`locale-status.test.ts` 钉住 `macLocaleNote` 全文；`registry/tutorials.test.ts` 钉住那条问答提到从星芒和托盘「已安装的工具」
  打开；`testing/app-check.mjs` 的两条既有浏览器用例补断言：询问框正文带新加的那句，Windows 配置里语言那段第一段是新文字。
