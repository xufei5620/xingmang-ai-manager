## 开发

- 0.2.17 发版运行的 Windows 出包作业连挂两次，都是测试不稳：`test:ui` 十个套件的夹具页一律改走 `openFixturePage`（`ERR_NO_BUFFER_SPACE` 丢导航时在同一 90 秒预算里重开），`ci-workflow-config.test.cjs` 找 Windows 套件时把 `run-release-build.cjs` 跑的 npm 脚本也算进去（`test:ui` 只在发版时上 Windows，原门禁看不到）；`provider-sessions.test.ts` 等后台写探测缓存的 `vi.waitFor` 从默认 1 秒放到 10 秒。
