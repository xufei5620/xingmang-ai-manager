# 随包的官方 Codex 型号名单

`models.json` 是 OpenAI Codex 自带的型号名单，原样拷自上游，一个字节不改。主进程按当前账号能用的型号挑出其中几项，写给 Codex 命令行和桌面端（`electron/codex-model-catalog.ts`，原因见 `docs/CODEX-ACCOUNT-CONFIG.md`「型号名单」）。

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/openai/codex> |
| tag | `rust-v0.160.0`（提交 `a956835d020762cb2b570053af06f643a11c0ecc`） |
| 路径 | `codex-rs/models-manager/models.json` |
| sha256 | `fd219bd9f061278275f528939f82f54d2eb97df4b25c23b022adbe48813d920b` |
| 许可 | Apache-2.0，`LICENSE` 与 `NOTICE` 原样拷自同一 tag 的仓库根目录 |

## 为什么不能改

主进程读它时按 sha256 核对，对不上就整次运行都不写型号名单（`readBundledCodexModelCatalog`）；`electron/codex-model-catalog.test.ts` 也钉住这个值。手改一个型号的字段，等于替 OpenAI 编了一份 Codex 没测过的型号资料，而 Codex 读不进名单时命令行直接起不来、桌面端开不了新对话。

## 怎么换新

抬 Codex 推荐版本（`electron/cli-verified-versions.ts`）时一起换，选同一个 tag：

1. 从那个 tag 原样下载 `codex-rs/models-manager/models.json`、根目录的 `LICENSE` 与 `NOTICE`，覆盖这里的三个文件。不要经过会改换行或缩进的编辑器。
2. 改 `electron/codex-model-catalog.ts` 的 `bundledCodexModelCatalogSource`：`tag` 与 `sha256`（`sha256sum models.json`）。改这份 README 的表格。
3. 跑 `npx vitest run electron/codex-model-catalog.test.ts`：每个型号都要读得进（`rejected` 为空），要求的最低命令行版本（`codexModelCatalogRequiredCliVersion`）不能高过推荐版本。新名单要是用了 `codexModelCatalogEntryProblem` 不认识的固定取值，先查上游 `codex-rs/protocol/src/openai_models.rs` 再放进白名单。
4. 用真二进制核一遍：推荐版本的命令行、桌面端当前带的那版 Codex，各在临时 `CODEX_HOME` 里写一份指向新名单的 `config.toml`，跑 `codex debug models` 能列出全部型号、`codex exec` 不报 `Model metadata ... not found`。读不进的版本要么抬 `codexModelCatalogMinimumCliVersion`，要么这次不换。
