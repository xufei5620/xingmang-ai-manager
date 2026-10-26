## 开发

- `update-install-prompt.ts`：Mac 闲时装之前跟退出时装一样，先现读一次服务状态文件（宿主的 `refreshServiceStatus`
  接 `serviceStatusMonitor.refresh()`，最多等 `IDLE_INSTALL_STATUS_WAIT_MS` 3 秒，读不到、读得慢就按上次读到的撤回名单算），
  读完再确认这一版还能装才调 `installWhileIdle`。以前闲时装用的是定时读到的那份（15 分钟一次），把某一版放进撤回名单后，
  那一刻正好闲着、已经下好这一版的 Mac 最多还有 15 分钟会被自动装上它（0.2.22 发版前回归检查第 3 条）。被收回的那一版
  不算「试过了」，同一次运行里下一版下好照样能闲时装；等状态文件那几秒里星芒在退出就不装。
