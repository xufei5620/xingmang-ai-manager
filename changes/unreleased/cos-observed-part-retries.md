## 开发

- 依据真实同步日志，仅将分块 PUT 的 EPIPE 和已安全识别的 HTTP 400 UserNetworkTooSlow 纳入现有最多额外两次重试；复用同一已校验分块与会话，保持 1 MiB、并发、截止和非分块写入的原边界。
