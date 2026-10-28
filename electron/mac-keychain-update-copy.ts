// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// Mac 自签包没有苹果团队号，登录钥匙串只能按每一版程序自己的指纹放行「xingmang-ai-manager Safe Storage」，
// 所以每换一版，第一次打开都会弹一次钥匙串密码框（registry/tutorials.ts 的 macKeychainTutorialDetail；
// 10-28 升级冒烟在 runner 上对照过）。框在窗口出来之前就弹，事后没法再说，只能在装之前先打招呼：
// 设置页的确认框、跳框、必须更新那层、自动装的通知、退出时那一问都说这一句（yoyo 10-28「钥匙串提示改」）。
// 没有 Node 依赖，主进程和渲染层读同一份，两边各写一遍早晚会说岔。

export const macKeychainUpdateHint = '重启后 Mac 可能弹出钥匙串密码框，输入这台 Mac 的开机密码，点「始终允许」就好。'
