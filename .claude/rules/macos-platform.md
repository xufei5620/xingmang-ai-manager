---
paths:
  - "electron/macos-*.ts"
  - "electron/darwin-*.ts"
  - "electron/platform-capabilities.ts"
  - "src/platform-presentation.ts"
---

# macOS 路径信任与跨平台改动

> 从 `CLAUDE.md` 第 5 节 T5 原样搬出（2026-09-09），内容未改。这是按路径加载的规则：只有改到上面列出的文件时才进入上下文。

**T5. 修跨平台问题 → macOS 的路径信任问的不是 Windows 那个问题，别照搬。**

Windows 问「**低于 Administrator 的主体能不能写这里**」，因为那边程序可能持有提权令牌。**macOS 上这条边界不存在**：本程序从不提权（`electron/` 下无 `sudo` / `AuthorizationExecuteWithPrivileges` / `osascript ... with administrator privileges`，`resolveWindowsCliExecutionMode` 非 win32 恒返回 `'same-user'`），它把 CLI 装进 `$HOME`。

所以 macOS 保留了问题的**形状**，只换掉可信集合的**成员**（见 `electron/darwin-path-trust.ts`）：

| 函数 | macOS 上的语义 |
|---|---|
| `isUserWritablePath` | 「**除 root 与当前用户之外**的主体能否改动它解析后的目标」——沿完整祖先链判定 |
| `isTrustedHighIntegrityExecutable` | 绝对路径 + 上面那条。管住 `diagnostics.ts:360/400` 两处 |
| `trustedCommandEnvironment` | 重建 PATH：固定机器目录在前，继承项在后，**每一项都过同一个判定**，首次出现优先 |

⚠️ **两个最容易误读的点**：

1. **`isUserWritablePath` 在 macOS 上对 `~/.local/bin/node` 返回 `false`** —— 用户确实能写那个路径，但它不是「外部主体可达」。名字读起来像 `access(W_OK)`，实际不是。
2. **这不是同 uid 防御。** 能写 `~/.local/bin/node` 的攻击者同样能写 `~/.zshrc` 或装 LaunchAgent。它挡的是**跨主体**的写入路径（world-writable、他人属主、符号链接逃逸）。

**刻意不做**（各有理由，别当成遗漏顺手补）：不读 SIP 的 `SF_RESTRICTED` 标志、不读扩展 ACL —— Node 的 `fs` 两者都看不到（`fs.Stats` 无 `flags` 字段，`fs.chflags` 不存在，无 ACL API），只能每个组件 spawn 一次 `/usr/bin/stat` 或 `/bin/ls -lde`，而这是个同步热路径。也不做缓存：全链走一遍实测 ~11 µs，不值得，也就不继承 Windows 侧 `programFilesAclCache` 永不失效的陈旧信任隐患。

**gid 80（admin）算可信写入方**，因为 macOS 默认 sudoers 的 `%admin ALL=(ALL) ALL` 已让其等价 root。这是产品决策，不是推断 —— 程序读不到 `/etc/sudoers`（`0440 root`）。

**仍然欠着的**：`runCommand` 的 `trustedOnly` 在 POSIX 上只换环境，`trustedPaths` 被静默丢弃、可执行文件不做可信解析。今天 macOS 上传 `trustedOnly: true` 的调用点是 **0 个**，所以无实际影响，但**新增这类调用前必须先补上**。

**来源可信（codesign / Team ID）是与本条正交的另一条轴**，由 `macos-codex.ts` / `macos-grok.ts` / `macos-codex-app.ts` 和私有暂存负责，不在这三个函数的职责内。

**改跨平台代码前先读 `electron/platform-capabilities.ts`**，它是判断"当前平台支持什么"的单一入口。
