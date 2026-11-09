## 开发

- D95 / 签名杀毒 AV-02：`package.json` 的 `author` 从「神风」改成「绍兴星芒文化传媒有限责任公司」。electron-builder 拿它当
  公司名，只写进三处：exe 文件属性的「公司」、安装程序的版本信息、卸载注册表的 `Publisher`（「设置 › 应用」里的发布者）。
  数据目录跟 productName、卸载注册表键名跟 appId、开机项跟 AppUserModelId，都不受影响；配置里没开 `menuCategory`、
  也没用 `${author}` 宏，开始菜单和安装包文件名不变。Linux 的 maintainer / vendor、Mac 的版权本来就单独写死。
  `scripts/update-release-utils.test.cjs` 钉住的值跟着改。客户看得到的那句（「设置 › 应用」里发布者改成公司全称）
  这批先不写进「## 用户」，最后统一补。
