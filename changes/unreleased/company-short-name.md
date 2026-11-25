## 开发

- 给人看的公司名改成简称「星芒文化」（yoyo 11-25 定）：`package.json` 的 `author`（Windows 程序和安装程序属性里的「公司」、
  卸载注册表的 `Publisher`，即「设置 › 应用」里的发布者）、`scripts/release-copyright.cjs` 的版权人（Windows 属性里的「版权」、
  Mac「关于星芒AI管理工具」那一行）、`electron-builder.config.cjs` 的 Linux `maintainer` / `vendor`，以及仓库根目录 `LICENSE`
  的中英文版权声明（yoyo 回「许可也简称」）。卸载注册表键名按 appId、
  安装目录按 productName，都不受影响，老客户升级只是「发布者」那一栏换成新名字。
- 签名发布比对证书用的 `updatePublisher`（写进 `app-update.yml` 的 `publisherName`）**保持登记全称**：证书机构只写全称，
  这里改了会让那一版以后的客户拒收所有签名更新。旁边补了注释，`update-release-utils.test.cjs` / `macos-build-config.test.cjs`
  原本就钉着全称。签名相关文档（`docs/IMPROVEMENT-PLAN.md` 3.4、`docs/archive/RELEASING-signed.md`）讲的是证书名字，
  `CHANGELOG.md` 旧记录、`ui-spec/` 旧设计稿（不进安装包）都不动。
