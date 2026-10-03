## 开发

- COS 分块上传仅对明确超时的同一分块最多额外重试两次，复用已校验内容并保留总期限、并发收拢及 Complete 未确认后的完整回读边界。
- 对可信 COS 分块 HTTP 错误以 4 KiB、5 秒上限提取白名单错误码，区分 RequestTimeout 与 BadDigest 等错误，保留 HTTP 状态且不记录错误正文或认证数据。
