## 用户

- 修好：打开 Codex 桌面端时顺带连上的加速如果连得慢，关掉桌面端后不会自动断开、一直开着。
  现在不管连得快慢，关掉桌面端后都会自动断开。
- 游戏加速页上，打开 Codex 桌面端时自动连上的加速不再显示「正在计时」，改为「自动连接不计时」。

## 开发

- `electron/codex-desktop-acceleration.ts`：自动连接超过 15 秒预算时，`ensureConnected` 按超时返回、桌面端照常
  打开，但加速服务那边的连接撤不回来，迟到连上后是一条不扣时长、没有到期的会话，而「桌面端退出就断开」的守护只在
  准时连上时才挂，于是一直开到退出星芒（A014 2026-10-02 报告）。超时后改为接着等连接结果，迟到连上照样挂守护，
  日志 `acceleration.codex-desktop.connected` 带 `{ late: true }`。另加 `observe(state)`，由 `main.ts` 接到加速服务的
  `onState`：任何一份「当前账号、正连着、`autoStartedBy` 为 codex-desktop」的状态都会被接着盯，同一次会话只盯一份。
  守护每次检查先比账号再读状态：原来换账号或退出登录后读旧账号状态被拒，落进 catch 每分钟重排，永远停不下来。
- `src/renderer-v2/features/acceleration/AccelerationView.tsx`：自动连接的会话额度圈下那行原来照普通连接写
  「正在计时」，与旁边「自动连接不扣免费时长」矛盾，改为「自动连接不计时」。
