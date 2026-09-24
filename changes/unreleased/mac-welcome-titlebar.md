## 用户

- Mac 上刚打开时，启动页和欢迎页的顶栏一出来就给左上角的红黄绿按钮让好位置，不再先挤一下再跳过去。

## 开发

- renderer-v2 的系统类型在挂载前就定好：`main.tsx` 先按 Chromium 自报的系统写 `data-os`，`App.tsx` 在平台能力回来前沿用它（以前先写 `win`），并把它显式传给 `Splash` / `Welcome` 的 `AuthWindow`；判断收口到 `features/app/window-os.ts`。`testing/app-check.mjs` 逐帧记录启动页和欢迎页的 `data-os`，钉住 Mac 上每一帧都按 Mac 排版。
