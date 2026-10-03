## 开发

- 打包器复用 Electron 43 已采用的 `@electron/get 5.0.0`，移除构建依赖中的旧 `got`、`cacheable-request` 和受 GHSA-ch52-4w7c-c8xp 影响的 `http-cache-semantics` 链；保持 npm 官方源、SHA-512 锁定和零漏洞审计门槛。
- 固定 `electron-builder 26.15.3`，根据上游迁移补充构建下载的十分钟截止时间、标准代理/TLS 校验和服务端/临时网络错误重试；安装时核对原模块 SHA-256，未知源码或版本拒绝应用兼容补丁。
- 本次只调整构建下载依赖，不改变 Electron 版本或客户端运行时依赖；验证包含依赖审计、编译和打包器兼容性。
