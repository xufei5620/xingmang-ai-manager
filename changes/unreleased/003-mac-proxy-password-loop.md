## 用户

- Mac 上不会再一遍遍弹「输入密码允许此操作」：以前上次加速留下的网络设置没改回时会反复弹，现在点了取消就不再自己弹，等你下次点「开启加速」或「停止加速」再问一次；系统代理被 Clash 这类代理软件接管的网卡不再碰。弹窗里写的名字从「macos-system-proxy」改成「星芒AI管理工具」。
- Mac 上从星芒打开 Codex 少弹一次密码框：Codex 已经开着的时候从星芒再打开它，不再为它连一次加速；为打开 Codex 临时连上的加速，Codex 一打开就断开。

## 开发

- 客户 Mac 上开着 Clash（127.0.0.1:7897）时，旧加速会话的恢复记录让启动恢复每次都先弹授权、再因为「有开着的 127.0.0.1 代理」判成配置错误，后台按 5/15/30/60/120 秒重试，独立加速进程在主程序退出后还在弹（2026-10-18 排查）。原生助手（`native/macos-system-proxy.swift`）：只把「开着、主机 127.0.0.1、端口等于恢复记录里那个端口」认成自家，别人的回环代理跳过；恢复先只读算出要写什么（`plan`），没东西要写而且系统里已生效就直接删记录、不要授权，自家端口被改过一半的网卡在弹窗前就报新错误 `conflict`；SCPreferences 加锁、提交、生效被拒（`kSCStatusAccessError`）报 `authorization` 而不是 `configuration`。
- 取消就停：助手记住「上次没拿到用户同意」，之后自己发起的恢复（父进程断开时的清理、`stop`）走新的 `restore-quiet`，有东西要写就报 `deferred`、不弹窗、记录留着；`restore`、`recover` 照旧会问。断开后的清理最多试 3 次，被拒、`deferred`、`conflict`、`busy` 当场退出（以前没有上限）。`platform/macos-system-proxy.ts` 新增 `restoreQuietly()` 和 `release()`，错误带上封闭的原因（`accelerationProxyFailureCauses`：declined、deferred、conflict、busy、storage、configuration、helper、other），日志只记这个词。
- 后台（`acceleration-development-backend.ts`）：Mac 上恢复被拒或连续失败 3 次后改用不弹窗的恢复，重试间隔放到 60 秒；只有用户点「开启加速」「停止加速」才再问。worker 启动恢复被拒时不再让初始化失败，状态显示新的 `proxy-declined`（「上次加速改的网络设置还没改回。点「开启加速」或「停止加速」时会再问一次电脑密码，输入后就能改回。」，托盘「网络设置还没改回，要输电脑密码」）；host 记住这件事，之后重拉 worker 也不弹，直到用户点开启或停止。worker 退出清理在没有内核在跑时最多 4 次，恢复被拒就直接退，内核在跑时先放掉助手。
- 日志：`acceleration.recover.withheld`、`proxy-restore` 失败、助手故障都带上原因词，以前一律只有 `proxy-restore`。
- Codex 桌面端（只 Mac）：Codex 已在运行、启动参数用不上时，`codex-desktop-startup-route.ts` 不再为它连加速（新日志 `codex-desktop.startup-route.already-running`）；为打开 Codex 连上的加速，第一次检查放在 20 秒（`startupDisconnectMs`），看到窗口就断开，正好落在系统授权 30 秒有效期里，断开不再另弹一次。这两个默认值是协调者按推荐定的，发版前可改。Windows 行为不变。
- 测试：原生夹具新增 4 条（另一个回环代理不动、没东西要写不弹窗、自家端口被改过在弹窗前拒绝、不弹窗恢复留记录并让出锁），夹具把弹窗次数记在旁边的 `.authorizations` 文件里；只在 Mac CI 的 `npm run test:mac:proxy` 跑。主进程侧补了 backend、host、wrapper、Codex 启动路由和加速 watch 的用例。
