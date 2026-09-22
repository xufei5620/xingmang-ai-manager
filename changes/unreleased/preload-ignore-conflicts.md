## 用户

- 修好了加速页检测到 VPN 或其他代理时那颗「仍然连接」按钮：之前点了它不起作用，还是被同一条
  冲突提示挡回来；现在点下去会跳过检测、直接连接。

## 开发

- `electron/preload.ts` 的 `startAcceleration` 桥接只收三个参数，第四个 `ignoreConflicts`
  （用户对冲突提示按下的「仍然连接」）在过桥时被丢掉，主进程每次都按「没确认过」再拒一次。
  改为四个参数都转发，末尾可选参数按实际个数传、不补空位，与渲染层 `api.ts` 和主进程
  `acceleration:start` 的分支同一口径。`electron/preload.test.ts` 钉住四种调用形态逐个过桥。
