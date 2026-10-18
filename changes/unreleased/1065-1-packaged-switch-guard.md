## 开发

- 打包版拒绝调试开关的检查不能再换个写法绕过（#1065 第一步）：`electron/security.ts` 的 `hasDisallowedPackagedDebugSwitch` 照 Chromium `base/command_line.cc` 的读法比较开关名，先去掉首尾空白，再去掉 `--` 或 `-`（Windows 上还有 `/`），名字截到第一个 `=`。之前只认 `--` 开头，`-remote-debugging-port=9222`、Windows 上的 `/remote-debugging-port=9222` 都能过，Chromium 照样开远程调试。黑名单补上能让 Chromium 拉起任意命令的 `--gpu-launcher`、`--renderer-cmd-prefix`、`--utility-cmd-prefix`、`--zygote-cmd-prefix`、`--browser-subprocess-path`，以及 Node 的 `--inspect-wait`、`--inspect-brk-node`。
- 检查从 `main.ts` 挪到 `platform/entry.ts`，在分出任何一支之前做：之前卸载清理、加速辅助进程这几支根本不经过 `main.ts`，带着这些开关走清理那一支就不受检查。`e2e/packaged-hardening-smoke.mjs` 在 Windows、Linux 的打包冒烟里加测单短横线和斜杠写法。
- 仍是黑名单：没列进去的开关照样生效；检查跑在 Chromium 读完命令行之后，启动早于主进程脚本的子进程已经用上的开关，这里退出也拦不回来。只放行已知参数是 #1065 的下一步。
