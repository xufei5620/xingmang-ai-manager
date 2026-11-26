# 随包的 Antigravity 中文词表

`zh-CN.json` 是开源插件 Antigravity Usage Monitor 里的简体中文界面词表，原样拷自上游发布 tag，一个字节不改。星芒从自己这边打开 Antigravity 桌面端时，用星芒自己写的换字脚本按这份词表把界面上的英文换成中文（`electron/antigravity-desktop-chinese.ts`）。插件本身不装，插件的代码也不用、不抄。

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/yuhuan-dev/antigravity-usage-monitor> |
| tag | `v1.5.6`（提交 `15ca28144c5ca314049e531b09d1befa75474a9f`） |
| 路径 | `host-i18n/dist/packs/zh-CN.json`（词表版本 1.0.3） |
| sha256 | `7d7c53e762864e1be8f49528365361b6b6f7e158702348b23f2739ef570e4453` |
| 许可 | GPL-3.0，`LICENSE` 原样拷自同一 tag 的仓库根目录 |

## 许可怎么守

词表按 GPL-3.0 发出去：许可原文 `LICENSE` 跟着它放在同一个目录、一起进安装包，来源写在上表，第三方许可清单（`scripts/third-party-notices.cjs`）里也列着它。这份 JSON 本身就是它的源码形式，原样不改，所以不用另附源码。星芒的代码只把它当数据读，换字脚本是星芒自己写的；要是哪天想改词表里的字，改过的那份也得按 GPL-3.0 公开，先回来问。

## 为什么不能改

主进程读它时按 sha256 核对，对不上就不放中文（`readBundledAntigravityChinesePack`）；`electron/antigravity-desktop-chinese.test.ts` 也钉住这个值。手改会同时打破上面那条许可的守法。

## 怎么换新

上游跟着 Antigravity 改版更新词表。要换时：

1. 选上游一个发布 tag，从那个 tag 原样下载 `host-i18n/dist/packs/zh-CN.json` 和根目录的 `LICENSE`，覆盖这里的两个文件。不要经过会改换行或缩进的编辑器。
2. 改 `electron/antigravity-desktop-chinese.ts` 的 `bundledAntigravityChineseSource`（`tag`、`commit`、`version`、`sha256`），改这份 README 的表格。
3. 跑 `npx vitest run electron/antigravity-desktop-chinese`：每一条都要读得进（`rejected` 为 0），浏览器那组用例要过。新词表要是用了 `parseAntigravityChinesePack` 不收的写法（更长的句式、别的正则标志），先弄清楚为什么，再决定放宽还是不换。
4. 在真机上打开一次 Antigravity 桌面端，看界面换成中文、AI 回复和代码没被翻。
