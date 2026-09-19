## 开发

- `e2e/asar-tamper-smoke.mjs` 与 `e2e/packaged-hardening-smoke.mjs`（T-G9）：清理阶段不再
  用 `throw` 顶掉 `try` 里的真实失败原因。两处的 `finally` 改成收集清理问题、`console.error`
  输出，只有在断言本身没挂时才由清理问题决定退出码。此前「被篡改的 app.asar 仍然可以持续
  运行」这类安全断言失败，会在 CI 日志里被「未确认测试进程退出」替换掉。
- 审查总表 T-G1（`e2e/electron-smoke.mjs` 七个恒为 false 的死断言字段）经复核已随 M-01
  （#135）删除该文件一并消失，保存模式合并/重置与「改模型要重新校验才能保存」现由
  `npm run test:v2` 的 `app-check.mjs` 覆盖，无需另外改动。
