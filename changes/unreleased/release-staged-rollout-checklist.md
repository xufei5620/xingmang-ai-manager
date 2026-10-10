## 开发

- `docs/RELEASING.md`：发布前置条件和 CI 发布两处写上 0.2.19 起每一版都分批放量（触发发布之前用 service-status 设 `<版本号> 20`，
  核对两个更新地址，观察一天后填 `none` 全部放开）。忘了先设、发版已停在第二次批准时，service-status 会不会被等批准的上传挡住没验证过，
  写明了看到 Pending 时的退法：先 Reject 上传、批完放量、再 Re-run failed jobs。
