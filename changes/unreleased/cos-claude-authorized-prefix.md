## 开发

- Claude 桌面备用包、不可变候选清单和 latest 指针统一保存在 `xingmang/offline/claude/`，沿用已授权的 `xingmang/*`；示例 CAM 策略保持原有两个前缀，不扩大云权限。
- COS 可覆盖对象仍只允许三个固定 latest 指针，拒绝旧 `claude/latest.json` 和其它备用目录；星芒正式发版目录及正常安装方式不变。
