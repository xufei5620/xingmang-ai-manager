## 开发

- Linux 安全边界（Linux 版拆分第 ⑦ 步，Linux 尚未对外发布）：新增 `electron/linux-path-trust.ts`，
  Linux 上 `isUserWritablePath` / `isTrustedHighIntegrityExecutable` / `trustedCommandEnvironment` /
  relocated-folders 不再分别用「一律可信」和 macOS 规则，改问「除 root 与当前用户之外能否改动」，
  组可写目录按 `/etc/group` 实际成员判；`trustedCommandEnvironment` 在 Linux 上重建 PATH 并另剥
  `LD_*`、`BASH_FUNC_*`、`GCONV_PATH`、GTK/Qt 模块路径等注入变量；`runCommand` 的 `trustedOnly`
  在 Linux 上补齐可执行文件与路径参数的可信解析。
- Linux 上以 root 或替别的账号打开时直接提示并退出（`electron/linux-launch-guard.ts`）；画布打开前
  检查启动开关并读渲染进程的 `Seccomp`，系统沙箱没生效就不开（`electron/linux-renderer-sandbox.ts`）；
  日志与反馈报告在 Linux 上把主目录记作 `~`，并去掉 `/media`、`/run/user`、gvfs 里的账号名。
  Windows 与 macOS 行为不变。规则见 `.claude/rules/linux-platform.md`。
