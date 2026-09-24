## 开发

- #494（D20）：rollback-release 在撤回版本、覆盖根目录清单之前，就把备份清单引用的每个安装包完整下载一遍，核大小、SHA-512 与 blockmap（新增 `rollback-release.cjs verify`，与发布后 `update:verify-feed` 共用 `update-release-utils.cjs` 里同一段核对逻辑）。原先预检只 HEAD 一下确认文件在，200 但内容已被同名覆盖的安装包要等线上换过之后才暴露。`docs/SERVICE-STATUS.md` 的回退例子改成「0.2.11 退回 0.2.10」，并写明 0.2.10 自己出问题只能撤回 + 发 0.2.11（0.2.9 没发过、没有备份，0.2.8 低于客户端的回退下限）。
