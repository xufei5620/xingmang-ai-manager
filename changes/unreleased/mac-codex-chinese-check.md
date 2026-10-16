## 开发

- Mac 上 Codex 桌面端的中文检查不再要求 Electron Framework 里的系统中文包（`electron/codex-desktop-locale.ts`）。
  ChatGPT 26.1007 起（Powered by Codex & OWL）Mac 包里没有 Electron Framework.framework，网页界面和菜单的中文
  照样在 app.asar 里，以前三样缺一样就算没有中文，「检查中文界面」一直说缺少中文资源、「启用中文界面」一直报
  「当前 Codex Desktop 安装包没有本地简体中文资源」。Windows 照旧三样都要。
