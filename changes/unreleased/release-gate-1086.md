## 开发

- `publish-release` 的 release-tag 作业在查 tag、出包之前先跑 `node scripts/changelog-collect.cjs --assert-collected`：`changes/unreleased/` 里还有没汇总的分片就停下，什么都不动（#1086）。定版之后又合进来的改动照样进包，不拦的话客户更新说明一句不提，CHANGELOG 还会把它记到下一版；0.2.19 靠 #1039、#1108 两次补收才没出事。只出 Linux 包、不对外发的运行不查。
- publish 作业对这次选了的 Windows、macOS 出包作业要求 `success`，不再只挡 `failure`（#1090 第 1 项）：作业超时的结果是 `cancelled`，原来 Windows 超时这一版会悄悄只发 Mac，反过来也一样。`scripts/publish-workflow-config.test.cjs` 按各出包作业自己的 `if` 逐个平台核对。
