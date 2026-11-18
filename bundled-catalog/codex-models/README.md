# 随包的官方 Codex 型号名单

`models.json` 是 OpenAI Codex 自带的型号名单，原样拷自上游，一个字节不改。主进程按当前账号能用的型号挑出其中几项，写给 Codex 命令行和桌面端（`electron/codex-model-catalog.ts`，原因见 `docs/CODEX-ACCOUNT-CONFIG.md`「型号名单」）。

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/openai/codex> |
| tag | `rust-v0.170.0`（提交 `29eb79e9866b3262a777fdf8195c1b9e63684c91`） |
| 路径 | `codex-rs/models-manager/models.json` |
| sha256 | `d50b6749506d97e5f334dbabcb666eb1689f423cf3e88cfabdcf3c536b873068` |
| 许可 | Apache-2.0，`LICENSE` 与 `NOTICE` 原样拷自同一 tag 的仓库根目录 |

## 为什么不能改

主进程读它时按 sha256 核对，对不上就整次运行都不写型号名单（`readBundledCodexModelCatalog`）；`electron/codex-model-catalog.test.ts` 也钉住这个值。手改一个型号的字段，等于替 OpenAI 编了一份 Codex 没测过的型号资料，而 Codex 读不进名单时命令行直接起不来、桌面端开不了新对话。

## 怎么换新

抬 Codex 推荐版本（`electron/cli-verified-versions.ts`）时一起换，选同一个 tag：

1. 从那个 tag 原样下载 `codex-rs/models-manager/models.json`、根目录的 `LICENSE` 与 `NOTICE`，覆盖这里的三个文件。不要经过会改换行或缩进的编辑器。
2. 改 `electron/codex-model-catalog.ts` 的 `bundledCodexModelCatalogSource`：`tag` 与 `sha256`（`sha256sum models.json`）。改这份 README 的表格。
3. 跑 `npx vitest run electron/codex-model-catalog.test.ts`：每个型号都要读得进（`rejected` 为空），要求的最低命令行版本（`codexModelCatalogRequiredCliVersion`）不能高过推荐版本。新名单要是用了 `codexModelCatalogEntryProblem` 不认识的固定取值，先查上游 `codex-rs/protocol/src/openai_models.rs` 再放进白名单；新取值只要出现在官方标的最低客户端版本够新的型号上，旧版 Codex 就碰不到它（见下一节）。
4. 用真二进制核一遍：推荐版本的命令行、桌面端当前带的那版 Codex，各在临时 `CODEX_HOME` 里写一份指向新名单的 `config.toml`，跑 `codex debug models` 能列出全部型号、`codex exec` 不报 `Model metadata ... not found`。读不进的版本要么抬 `codexModelCatalogMinimumCliVersion`（命令行）或 `codexDesktopBundledCliVersions` 第一行（桌面端那一批），要么这次不换。
5. 桌面端出了表里还没有的新批次，就核一次它带的 Codex、在 `codexDesktopBundledCliVersions` 末尾加一行（没加之前按上一行算，只会少列新型号）。Windows 上装着的话跑 `C:\Program Files\WindowsApps\OpenAI.Codex_<版本>_x64__2p2nqsd0c76g0\app\resources\codex.exe --version`；没装的话，Mac 包在 OpenAI 的 appcast（`https://persistent.oaistatic.com/codex-app-prod/appcast.xml`）里列着，`ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` 里搜 `0.1xx.y-alpha.n.m` 这样的版本串（出现几十次的那个就是）。

## 新型号要的版本比本机 Codex 新

每个型号带一个官方标的最低客户端版本（`minimal_client_version`）。Codex 自己不看它，是 OpenAI 给官方账号下发名单时按客户端报上去的整版号（`client_version_to_whole`，0.167.0-alpha.3.2 报 0.167.0）筛型号。主进程照同一个办法逐个型号筛（`codexModelCatalogForClients`）：命令行或桌面端用不了的型号先不写进 `xingmang-models.json`，其余照写，不因为一个新型号整份收回。所以名单里多了要新版的型号时，不必等所有客户都更新到那一版才能换。
