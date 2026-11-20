# CI 重跑记账

> yoyo 2026-11-17 定「记账」：重跑才过的都记一笔；同一条两周内第二次出现必须查根因，不许再重跑放过；不删测试。
> 查清根因的写法和已经修掉的偶发红在 `docs/TEST-BASELINE.md`，这里只记账。

## 规矩

1. CI 红了，先看是不是这次改动弄的：失败的用例在不在改动碰到的代码上、分支是不是落后 main（落后先合进最新 main）。是这次改动弄的就修。
2. 不是的，先查账：`npm run ci:rerun-ledger -- <用例名里的几个字>`，它把账里对得上的都列出来，并说两周内有没有记过。
   - **两周内记过同一条**：不许再重跑。开线程查根因（云端线程请协调者开），在账末尾加一行，「处理」写 `查根因：` 加线程、issue 或 PR。修好合进 main 以后，本 PR 合进最新 main 再跑。
   - **两周内没记过**：在账末尾加一行，作为一个提交推到这个 PR 上。这次推送就是那唯一一次重跑，不再另点 Re-run。重跑还红就是真失败，回到第 1 步。
3. 不删测试、不跳过、不调大超时、不加等待把它盖过去。查不出根因也不删，写清楚排除了什么，记进 `docs/TEST-BASELINE.md`。
4. 同一个检查连修三轮还红，停手，写清卡在哪、试过什么，交回协调者（`AGENTS.md` 第 8 节）。
5. main 上的运行重跑才过的也记，由处理 main 报警的那个线程记在它自己的 PR 里。
6. 网络偶发（GitHub 下载 504、装系统包超时这类）照样记：同一个步骤两周内第二次，就该给它加缓存或重试，跟用例一样查。

## 怎么写一行

- **日期**：北京时间 `YYYY-MM-DD`，按先后往下加，只加在末尾。
- **用例或步骤**：用例照失败输出原样抄「文件 › 分组 › 用例名」；不是用例的写「工作流或作业 › 步骤名或报错」。查账按这一列整句比（不分大小写、空白和反引号），所以别改写、别缩写。
- **作业**：失败的那个作业，比如 `windows-test (vitest-2)`。
- **指纹**：报错里最能认出它的那一句。
- **运行**：运行号，Actions 地址里 `runs/` 后面那串数字。
- **PR**：`#1234`；main 上的写 `main`。
- **处理**：第一次一般写「重跑一次过」，没单独重跑、下一次推送过了的写「下一次推送过」。**两周内第二次必须以「查根因：」开头**，后面跟线程、issue 或 PR。`npm test` 里的 `scripts/ci-rerun-ledger.test.cjs` 逐行核对这几条。

## 账

| 日期 | 用例或步骤 | 作业 | 指纹 | 运行 | PR | 处理 |
|---|---|---|---|---|---|---|
| 2026-10-31 | upgrade-smoke › 新版本没有记下「本次启动是更新后的第一次」 | upgrade-smoke / windows-upgrade (0.2.19) | 新版本没有记下「本次启动是更新后的第一次」 | 41193398956 | #1565 | 重跑一次过 |
| 2026-11-11 | upgrade-smoke › 新版本没有记下「本次启动是更新后的第一次」 | upgrade-smoke / windows-upgrade (0.2.19) | 同上 | 42948887888 | #1748 | 查根因：#1771（冒烟查得太早，改成最多等 30 秒） |
| 2026-11-11 | electron/diagnostics.test.ts › diagnostics › PROVIDER_ENVIRONMENT_OVERRIDE › passes %s because the written configuration still wins | macos-test | `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`OPENAI_BASE_URL` 三条都是 `summary: 检查超时` | 42988685884 | #1756 | 下一次推送过（根因没查） |
| 2026-11-11 | e2e/v2-business.test.mjs › adding a uvx connection without Python says so first and still lets it through | windows-test (renderer-v2-e2e) | `locator.click: Timeout 5000ms exceeded`，等 `mcp-add`，停在 `performing click action` | 42992280184 | #1756 | 重跑一次过（根因没坐实，见 TEST-BASELINE） |
| 2026-11-11 | e2e/v2-business.test.mjs › a uvx connection missing uv points to customer support with a button instead of a pip command | windows-test (renderer-v2-e2e) | 同上一行 | 42992280184 | #1756 | 重跑一次过（同上一行） |
| 2026-11-11 | electron/git-runtime-install.test.ts › Git download deadline › still gives up on each source at the ceiling, in the words customers already see | windows-test (vitest-2) | `expected 3800000 to be less than 3640000` | 43011123157 | #1794 | 重跑一次过（#1798 查清并修了） |
| 2026-11-18 | e2e/windows-powershell-probes-smoke.mjs › Codex merged and package probes still answer in ConstrainedLanguage | windows-package | `(killed after 90000ms)`：ConstrainedLanguage 下 `Invoke-Expression $env:XINGMANG_CONSTRAINED_SCRIPT` 跑满 90 秒；同一作业下一条约束模式用例用了 71 秒，上一个提交上这一作业是绿的 | 44185995992 | #1897 | 重跑一次过 |
| 2026-11-18 | electron/ai-chat-history-store.test.ts › ai chat history store › keeps 200 conversations and still checks every one it did not rewrite | windows-test (vitest-4) | `Test timed out in 30000ms`；这一条在前两次运行里用了 9817ms、8366ms，这次整个文件 36540ms，同一时段别的 Windows 作业也慢 | 44189056645 | #1897 | 重跑一次过 |
| 2026-11-18 | e2e/macos-dev-origin.test.mjs › the configured macOS development origin renders the real Electron app | macos-test | `test timed out after 30000ms`（testTimeoutFailure）：各步自己的超时（启动 10 秒、首窗 10 秒、加载 5 秒、欢迎页 5 秒）一个都没报，整条 30 秒先用完；上一个提交上这一作业是绿的，同一次运行里 Windows、Linux 真开应用的作业都绿 | 44301446616 | #1896 | 重跑一次（跟合进最新 main 同一次推送） |
| 2026-11-18 | electron/ai-chat-history-store.test.ts › ai chat history store › keeps 200 conversations and still checks every one it did not rewrite | windows-test (vitest-4) | `Test timed out in 30000ms`；那个 PR 只改 `config-save-service.ts`，跟它无关 | 44300429453 | #1921 | 查根因：#1926（用例一次经 store 存满 200 个对话，200 次原子写在慢 runner 上过 30 秒；改成直接写进文件） |
| 2026-11-18 | macos-test › Run npm test | macos-test | `The operation was canceled.`：整个作业撞 42 分钟上限，`npm test` 跑了 38 分钟还在 `test:browser`；同一时段 #1927 的 macos-test 里 `npm test` 只用了 18 分钟，本 PR 只改了一条 Windows 上慢的用例和文档 | 44310396569 | #1926 | 重跑一次过 |
| 2026-11-18 | electron/codex-remote-service.test.ts › codex-remote-service images › keeps at most five images waiting for the next prompt | windows-test (vitest-2) | `vi.waitFor` 里只等到第一句「收到图片。再发一句要 Codex 做什么，会跟图片一起交给它。」，第二句「一次最多带 5 张图片，这张没收。」没到；这个 PR 只改版本号、两份更新日志和分片，不碰代码，同一次运行里其余 Windows 分片在跑 | 44319145574 | #1929 | 重跑一次（这次推送） |
| 2026-11-20 | electron/codex-remote-service.test.ts › codex-remote-service images › keeps at most five images waiting for the next prompt | windows-test (vitest-2) | `expected [] to deeply equal [ …(2) ]`：1 秒内两句回话一句都没等到；这次推送是 #1934 合进 main，不碰手机遥控 | 44578842558 | main | 查根因：#1950（第二句回话前要原子写 7 次，Windows runner 上过了 `vi.waitFor` 的 1 秒；改成等发送本身） |
| 2026-11-20 | electron/codex-remote-service.test.ts › codex-remote-service images › keeps at most five images waiting for the next prompt | windows-test (vitest-2) | 同 11-18 那行：只等到「收到图片……」，「一次最多带 5 张图片，这张没收。」没到；这个 PR 只改聊天对话名和导出打码 | 44590308456 | #1940 | 查根因：#1950（同上一行） |
| 2026-11-20 | windows-test (vitest-2) › Run the vitest-2 shard | windows-test (vitest-2) | `The action 'Run the vitest-2 shard' has timed out after 15 minutes.`：没有用例失败也没卡住，最后一秒还在一条条出结果；这一分片近两天在 main 和别的 PR 上用了 10.0、12.8、13.5 分钟，贴着 15 分钟上限，本 PR 只给 `codex-config-syntax.test.ts` 加了几条毫秒级用例 | 44592026258 | #1946 | 重跑一次（这次推送） |
| 2026-11-20 | electron/codex-remote-service.test.ts › codex-remote-service images › drops waiting images on a new conversation but keeps the last prompt's for retry | windows-test (vitest-3) | `expected 0 to be greater than 0`：用例开头的 `prompted()` 里 `vi.waitFor` 1 秒内没等到 `turn/start`；这个 PR 只改 Mac 上 Codex / Grok 的识别和首页提示，不碰手机遥控 | 44739575433 | #1949 | 重跑一次（这次推送） |
| 2026-11-20 | e2e/v2-local-avatar.test.mjs › crops a local image to a 256px PNG and persists it only for the selected account | windows-test (renderer-v2-e2e) | `locator.click: Timeout 7000ms exceeded`，等「更换头像」，元素可见可点，停在 `performing click action`（跟 11-11 v2-business 那两行同一个样子）；这个 PR 不碰账号页和头像 | 44741601202 | #1949 | 重跑一次（这次推送） |
