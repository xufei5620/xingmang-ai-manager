## 开发

- Linux 能打包了（尚未对客户发布，见 `docs/LINUX.md`）：只出 `.deb`，x64 与 arm64 各一份，装到 `/opt/xingmang-ai-manager`，菜单仍叫「星芒AI管理工具」。打包标记 `XINGMANG_LINUX_PACKAGE=1` 把 productName 换成英文名（`npm run build:linux` / `build:linux:ci`），`beforePack` 拒绝没带标记的 Linux 构建、带标记的其他平台构建，以及任何 Linux 发布模式构建（发版流水线做完之前 Linux 只出本地测试包，更新器关着）。
- `build/linux/after-install.tpl` 照抄 electron-builder 26.15.3 的 postinst，只把按 `unshare --user` 判断的那段换成无条件 `chown root:root` + `chmod 4755` chrome-sandbox：postinst 以 root 跑，探测几乎总说「不需要」，客户以普通用户打开时就起不来。`scripts/linux-build-config.test.cjs` 钉住配置并比对上游模板，全仓不许出现关沙箱的开关。
- 新增 `scripts/verify-linux-deb.cjs`（控制字段与依赖、包内全归 root 且只有 root 能写、无包外链接与多余安装位置、postinst、菜单文件、ELF 架构、更新器关着）和 `e2e/linux-deb-smoke.mjs`（读装好的目录权限，再以普通用户启动，从 `/proc` 确认无关沙箱参数、渲染进程 Seccomp 为 2）。`verify-packaged-hardening.cjs` 按文件名认出 Linux 主程序。
- CI：`quality.yml` 新增 `linux-package`（进 quality-gate），x64 在 ubuntu-24.04、arm64 在 ubuntu-24.04-arm，打包、校验、apt 真装、开启 Ubuntu 24.04 用户命名空间限制后普通用户真开、跑 packaged-hardening-smoke、卸载后确认不留东西。`package-for-testing.yml` 加 `linux` 选项（`both` 仍只指 Windows 与 macOS），artifact 名带 `NO-AUTO-UPDATE`。
