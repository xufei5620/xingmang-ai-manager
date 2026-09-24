## 开发

- #493（D19）：publish-release 的 publish 作业在第一次上传之前新增「Refuse to overwrite a version that already shipped」：tag 已存在且指向别的 commit，或线上 `latest.yml` / `latest-mac.yml` 已是这个版本（或更高）而本次产物不是同一批文件（`scripts/publish-guard.cjs` 逐个比 SHA-512 与大小），直接停下。原先只发 Mac 时要到最后打 tag 才发现版本号撞车，线上的 Mac 包那时已被同名覆盖。同一 commit 上先发 Windows 再补发 Mac、以及同一批产物的发布作业重跑仍然放行。
