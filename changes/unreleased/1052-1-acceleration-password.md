## 开发

- 换加速节点密码的出包准备（#1052 第一步）：出包时环境变量 `XINGMANG_ACCELERATION_PASSWORD`
  有值，`stage-acceleration-bundle.cjs` 先按 `profile.sha256` 核过仓库那份节点配置，再把全部线路的
  密码换成它，用运行时解析器读回确认，资源清单和安装包钉换过以后那份的哈希；没值或为空串照旧用
  仓库里那份，所以合进去以后发出的包不变。线路密码不止一个时拒绝替换，节点配置是占位符
  `__XINGMANG_ACCELERATION_PASSWORD__` 又没给密码时停下报错，报错和日志不带密码本身。
- `publish-release.yml`：Windows 出包挂新环境 `accel-profile`（只放行 main、不设审批，不多一次批准），
  Mac 出包从已有的 release 环境读同名 secret，两边都只绑在准备加速资源那一步。测试包工作流不读。
- `docs/GLOBAL-ACCELERATION.md` 登记 #1058 第 3 条：本机代理端口不加密码，定为接受的风险。
