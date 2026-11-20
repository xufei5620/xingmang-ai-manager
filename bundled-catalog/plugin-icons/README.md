# 「插件」页的 GPT 官方插件图标

`codex/` 下是 OpenAI 插件目录（GPT 官方那一组）里各个插件自带的图标，统一转成 96×96 PNG；带深色版的另有 `-dark.png`。`index.json` 记下每个文件的 sha256、来源提交，没带图标的（`missing`）和拒收的（`rejected`）各记一笔。渲染层由 `src/renderer-v2/registry/plugin-icons.ts` 经 Vite 打进 `dist/`，不进 `electron-builder.config.cjs` 的 `extraResources`。

两样东西都**只在我们这边**发版前生成，客户电脑上只读这里转好的图：不联网取图标、不读插件目录里第三方写的图标路径，也就不用在客户那边防路径穿越和 SVG 里的脚本。

| 项 | 值 |
| --- | --- |
| 目录 | <https://github.com/openai/plugins>，提交 `981b02c0c44058b595f3b4180002c3ae3c806d40`（存储桶里那份 Codex 插件目录用的同一个提交） |
| 目录外的插件仓库 | CrowdStrike/foundry-skills `c18b23e0…`、CrowdStrike/fusion-skills `74b9e027…`、qodo-ai/qodo-skills `20f9ba53…`（完整提交号见 `index.json`） |
| 生成脚本 | `scripts/build-plugin-icons.mjs`（测试 `scripts/build-plugin-icons.test.cjs`） |

## 商标

这些图标是各家的商标或标识，版权归各自所有者。这里只用来在列表里认出是哪个插件，除了缩放到统一大小、给留白太多的 SVG 裁掉四周空白，没有改图。不要拿去做别的用途，也不要改色或拼接。

Claude 官方那一组的市场清单不带图标，用的是 `simple-icons`（npm 依赖，CC0）里对得上的那一家，表在 `plugin-icons.ts` 的 `claudePluginBrands`，不在这个目录里。

## 怎么换新

GPT 官方目录加了插件、或者想跟上新图标时重跑一次（发版前做，不用每次都跑；目录里新加、这里还没有的插件，界面上落到通用图标，不会坏）：

1. 克隆 `openai/plugins` 到本地，检出存储桶那份目录用的提交；`index.json` 里 `repos` 列的三个插件仓库各克隆一份。
2. 跑：
   ```bash
   node scripts/build-plugin-icons.mjs --catalog <openai/plugins 克隆> \
     --repo crowdstrike-falcon-foundry=<foundry-skills 克隆> \
     --repo crowdstrike-falcon-fusion=<fusion-skills 克隆> \
     --repo qodo=<qodo-skills 克隆>
   ```
   它用 Playwright 的 Chromium 把 SVG / JPEG / WebP 转成 PNG，转的时候拦下一切网络请求；云端容器里设 `XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium`。
3. 看结尾那行：拒收的要逐个看原因（带脚本、带外部链接、跳出插件目录等），不要为了收下去改脚本里的检查。
4. 改这份 README 的表格，跑 `npx vitest run src/renderer-v2/registry/plugin-icons.test.ts` 和 `node --test scripts/build-plugin-icons.test.cjs`。
