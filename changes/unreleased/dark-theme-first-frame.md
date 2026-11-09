## 用户

- 选了深色外观的，打开窗口时不再先闪一块浅色屏（登录着的以前要闪到账号恢复完，最长 3 秒）。

## 开发

- 启动速度深查 S-1：renderer-v2 的 `main.tsx` 第一帧把 `data-theme` 写死成 `light`，没读主进程早就拼进地址的 `?theme=`
  （`resolveMainWindowUrl`，旧界面 `src/app-shared.ts` 是读的，换到 v2 时丢了），深色用户每次开窗先看到浅色的 Splash，
  要等 `boot`（它等账号开机闸门，最长 3 秒）和设置回来才变深。新加 `features/app/initial-theme.ts`，只认 `light` / `dark`，
  别的值照旧按浅色。
- 界面进程崩溃后自动重新加载、「界面没有响应」里点重新加载，原来是 `webContents.reload()`，会带着开窗那一刻的 `?theme=`；
  中途换过深浅色的，重新加载出来第一帧又是旧的那套。改成和缩到托盘后重新加载一样，按此刻存的主题重拼地址再 `loadURL`。
