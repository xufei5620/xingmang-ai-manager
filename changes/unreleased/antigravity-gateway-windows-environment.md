## 开发

- Antigravity 接中转第一步，只有主进程、不接界面：`electron/antigravity-gateway.ts` 算出它「企业网关」模式要的四个变量
  （地址只收中转线路的 https 裸域，型号菜单是密钥当时列出的全部型号、`gemini-3.8-flash` 排第一），
  `electron/antigravity-windows-environment.ts` 把它们写进 Windows 当前用户的环境变量（REG_SZ、不提权、没变就不写不通知）。
  两种 PowerShell 语言模式都在 `e2e/windows-powershell-probes-smoke.mjs` 里真跑对照注册表。
