## 开发

- `publish-release` 改成一开始就把这一版的 tag 占在要出包的 commit 上（新的第一个作业 `release-tag`：先判断、再用 API 建，出包作业都等它；它拿着写权限，所以不装任何依赖），收尾建 GitHub Release 时不再传 `--target`。原因：`GITHUB_TOKEN` 拿不到 `workflows` 权限，出包之后 main 只要合进改 `.github/workflows` 的提交，GitHub 就拒绝它在出包的 commit 上建 tag 和 Release，0.2.14 的收尾因此两次 HTTP 403，只能手工补。
- 这个版本号已经从别的 commit 发过、线上清单已经比它高、或者在撤回名单里，`release-tag` 就停下，不再等一个多小时出完包才发现；上一次触发占了 tag、没发出去就取消的，重新触发会把 tag 挪到新的 commit 上（`scripts/release-tag-plan.cjs`）。出包期间 tag 被删了，上传前那道关检查都过了以后先补建再传，补建不了就停下、线上不动。
- `scripts/update-release-utils.cjs` 改成用到时才加载 `yaml`，不装依赖的 `release-tag` 也能用它算更新地址、比版本号。
