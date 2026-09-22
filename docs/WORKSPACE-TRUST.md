# 打开目录时替用户写下的「信任」

本软件的首页点「打开」时，用户已经在自家的目录对话框里亲手选过那个目录了。再让他在终端里
读一遍 CLI 自己的英文信任问答，只是白多一道门槛。所以打开之前，主进程会先把「这个目录可信」
写进对应 CLI 自己的配置。

- 实现：`electron/config-files.ts` 的 `trustManagedWorkspace`
- 调用点：`electron/system-service.ts` 的 `launchProviderOperation`（在解析 CLI 命令之前）
- 单测：`electron/config-files.test.ts`、`electron/system-service.test.ts`

## 实测到的字段

两家的字段都**没有官方文档**。下面是 2026-09-21 在 Linux 沙箱里实测的结果：空 `HOME` 加一个
临时工作目录，用伪终端把 CLI 的首启向导走完并接受信任，再 diff 出它们到底写了哪些文件。

| CLI | 版本 | 文件 | 写了什么 |
|---|---|---|---|
| Claude Code | 2.1.277（推荐版本名单里的那个） | `~/.claude.json` | `projects["<绝对路径>"].hasTrustDialogAccepted = true`；首启向导另记在顶层的 `hasCompletedOnboarding = true` |
| Gemini CLI | 0.60.0（当时的 npm latest） | `~/.gemini/trustedFolders.json` | `{ "<绝对路径>": "TRUST_FOLDER" }` |

Gemini 的取值是一个三值枚举，从它的 bundle 里核到：`TRUST_FOLDER` / `TRUST_PARENT` /
`DO_NOT_TRUST`。

反过来验证过一遍：把这两项预先写好再启动，Claude Code 直接进对话框（不问主题、不显示安全
须知页、不问信任），Gemini CLI 也不再弹「Do you trust the files in this folder?」。

Claude Code 的主题写在 `~/.claude/settings.json` 的 `theme`，**本软件不写它**——那是用户自己的
显示偏好，`hasCompletedOnboarding` 一项就够跳过向导了，跳过之后用的是 CLI 自己的默认主题，
用户随时可以 `/theme` 改。

## 约束

- **只对用户在本软件里亲自选的目录生效。** 没有任何「批量信任」「信任父目录」的入口。
- **已经写着的答案一律不动。** 用户自己在 CLI 里答过「不信任」（Claude 的
  `hasTrustDialogAccepted: false`、Gemini 的 `DO_NOT_TRUST`）也是一个决定，本软件不替他翻案；
  同理，`~/.claude.json` 里别的项目条目、MCP 配置、会话计数原样保留。
- **写入是读-改-写同一份文件**，走 `executeFilePlans` 的两阶段提交 + `.bak` 备份 + 失败回滚
  （I9），路径先过 `assertSafeConfigPath` / `assertNoReparseComponents`（I8）。
- **写不进去不阻塞打开。** 文件损坏、只读、主目录被重定向时跳过，往 `runtime.jsonl` 记一条
  `workspace.trust.failed`，CLI 自己还会问一次。日志里不带目录路径，原因先过
  `redactHomeDirectory`（I13）。
- **不改就不写。** 已经信任过的目录第二次打开时 `changed === false`，一个字节都不动，也不会
  再堆一份备份。

## 哪些目录一律不写

判定在 `electron/workspace-guard.ts` 的纯函数 `classifyWorkspace` 里，五类：

| 类别 | Windows | macOS |
|---|---|---|
| 主目录 | `C:\Users\<用户名>` | `/Users/<用户名>` |
| 盘根 / 卷根 | 任意盘符根、UNC 共享根 | `/`、`/Volumes/<卷名>` |
| 桌面 | `…\Desktop`、OneDrive 重定向后的 `…\OneDrive\桌面` | `…/Desktop` |
| 下载 | `…\Downloads`、`…\OneDrive\下载` | `…/Downloads` |
| 文档 | `…\Documents`、`…\OneDrive\文档` | `…/Documents` |

原因是这两件事都「配一次管整棵目录树」：Claude Code 读工作目录**及其上层**的每一份
AGENTS.md，所以主目录里的一份会对这台电脑上的所有项目生效，而用户在任何子目录里都看不见
它在哪；信任同理，写在主目录上等于把整台电脑标成可信。

- **子目录不算敏感**：`桌面\我的项目` 照常写信任、照常生成说明。有人确实把项目放在桌面上。
- **拦是提示，不是禁止**：`workspace:choose` 选到这几类目录时弹一次中文提示，用户可以
  「仍然打开」，打开本身从不被拦住；只是这一次不写信任、不生成 AGENTS.md，信任那一问交还给
  CLI 自己 —— 在这种目录上那一问是有意义的。
- **记住的目录走同一段**：判定在 `launchProviderOperation` 里，所以老用户早就记住的主目录
  再打开也不会补写。只有选择器那一步会提示。
- **判不准就放行**：这个判定不读磁盘也不查注册表（Windows 的已知文件夹重定向只能按路径形状
  认），拿不准时一律当普通目录——误判会让正常项目莫名其妙丢掉信任写入，代价比少拦一次大。
- **已经写进去的不回收**：主目录里已有的 `AGENTS.md`、已写下的信任条目都不删，那是用户目录
  里的文件。

## 上游改了怎么办

字段名是上游的实现细节，随时可能改名或消失。这里的写法本来就是「只补这一项、其余不碰」，
所以字段消失时最坏的结果是这一步静默失效、用户回到今天的样子（在终端里被问一次）。
**不要反过来把这些字段当成「这个目录是否可信」的判断依据**，也不要在读不到时报错。
抬 Claude Code 推荐版本时（`electron/cli-verified-versions.ts`）顺手按上表复测一遍。

## 不在这条路径上的两个

- **Codex**：它的信任连带 `approval_policy` 与 `sandbox_mode` 两项默认值，是配置对话框里一个
  单独的按钮（`trustCodexWorkspace`），语义比这里宽，没有并进来。
- **Grok CLI**：没有目录信任这一说。
