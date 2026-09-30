## 开发

- 依赖锁文件把 axios 从 1.18.1 升到 1.20.0（随之 form-data 4.0.6）、dompurify 从 3.4.15 升到 3.4.16，修掉 9-30 新出的 13 条公告让 CI 构建依赖审计报红：axios 12 条（GHSA-3pq3-5fj3-cg6v、GHSA-44g4-m2mj-wpvx、GHSA-4hqw-qxg8-jxx2、GHSA-542g-h47m-68v8、GHSA-9fr6-4gfg-395g、GHSA-c29m-xwm3-cm6r、GHSA-j8rh-479h-cp32、GHSA-m8m8-qj5v-23w3、GHSA-mghh-pgcx-3jjj、GHSA-r4gj-5m52-g5wh、GHSA-vh66-26gq-q6x8、GHSA-x97p-jq2g-jp4f，修复版 1.20.0）与 dompurify 1 条（GHSA-p98j-92pf-mc4p，修复版 3.4.16）。两者分别是 wait-on 与 mermaid 的间接依赖，都在原有 semver 范围内，纯开发依赖，不进安装包。
