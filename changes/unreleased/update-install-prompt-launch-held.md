## 开发

- 跳框（`update-install-prompt.ts`，#1385）不再一刀切排除「打开时就已经下好」的版本，改成只排除自动装已经接手的那一版
  （`attempted`：打开时装、退出时装、闲时装记过的，每次现读）。开机自启后窗口一直缩着、打开时装挂成 `'window'` 等第一次开窗口的
  Windows，Mac 开机自启要输开机密码留到退出（`'skip'`）的，以及开机两分钟里没轮到的，这次运行也会在电脑空闲几秒时弹现有的框；
  以前开机自启、只关机不退出的 Windows 永远停在旧版（Refs #1410 问题 1 建议①）。`main.ts` 跳框前先 `withdrawLaunchInstall()`：
  撤掉 `launchInstallAwaitingWindow`，免得跳框叫出窗口时 `'show'` 又预告装一遍；同时置 `launchInstallTried`，客户回答前后打开时装
  不再自己装起来，点「稍后再说」的照框里说的退出或下次打开时装。日志新增 `install.on-launch.withdrawn`。框里的字不变。
