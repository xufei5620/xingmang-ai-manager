## 开发

- 发版：yoyo 2026-11-09 定「Linux先不发」。`publish-release.yml` 的 release-tag 判断那一步加了只关不开的
  `LINUX_PUBLISH_HOLD`：仓库变量 `XINGMANG_PUBLISH_LINUX` 开着、这次又选了 `all` 或 `linux` 时，在占 tag、
  出包之前就停下，发版改选 `both`。起因是 Ubuntu 22.04 / 24.04 上自动更新交给系统那一步推测装不上，要修好、
  真机点过再发。挂着等批准的 0.2.23 Linux 补发（运行 41408530433）同日取消。解除方法见 `docs/RELEASING.md`「Linux 开关」。
