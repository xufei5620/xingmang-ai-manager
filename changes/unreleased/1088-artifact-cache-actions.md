## 开发

- #1088 评论补充（接 #1220）：工作流里剩下三个还跑在 Node 20 上的官方 action 也换了大版本，`actions/upload-artifact` v4.6.2
  → v7.0.2，`actions/download-artifact` v4.3.0 → v8.0.2，`actions/cache/restore`、`actions/cache/save` v4.3.0 → v6.1.0，
  都改用 Node 24。仍钉完整提交号，提交号从官方仓库的发布标签核对。download-artifact v8 起下载后核对摘要、对不上就报错，
  只按名字和 `pattern` 下载、都是打包上传的，不受它另外两处改动影响；它只在 `publish-release.yml` 里用，PR 上不跑，
  开 PR 前在本分支用一次性探测工作流照那几步真传真收核过，探测工作流已删。
