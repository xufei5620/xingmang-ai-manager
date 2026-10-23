## 开发

- 依赖锁文件把 `dompurify` 从 3.4.16 升到 3.4.17，修掉新出的 3 条公告让 CI 构建依赖审计报红：GHSA-c6gr-qvv4-5v3f、GHSA-cg2g-xh64-v4q7、
  GHSA-mrv2-3pqr-j5jr（都影响到 3.4.16 为止）。它只是 `@lobehub/icons` → `@lobehub/ui` → `mermaid` 带进来的开发依赖，本仓代码不直接用；
  锁文件只改这一个包的 version / resolved / integrity（数据取自 npm 官方源），`npm ci` 装完锁文件不变。`canvas-v2/` 的锁文件 CI 不审，不碰。
