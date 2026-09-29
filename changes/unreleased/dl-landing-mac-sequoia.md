## 开发

- 下载页「Mac 第一次打开」主路改成「双击一次 → 系统设置 → 隐私与安全性 → 仍要打开 → 输开机密码」：macOS 15 起「右键 → 打开」已经不能放行。右键打开降为折叠段里给 macOS 14 及更早系统的补充；`docs/MACOS_FREE_DISTRIBUTION.md`、`docs/CI-PACKAGING.md` 同步改顺序。`scripts/dl-landing-install-guide.test.cjs` 钉住主路步骤里不再教右键。只改仓库里的下载页源文件，上线仍需手动发布下载页；界面原字按 macOS 15 中文界面写，未在真机上核对。
