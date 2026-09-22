## 用户

- 新手引导第一步默认选好了「Codex 桌面端」，排在第一个并标着「推荐」：它是图形界面，点开就能用，不用准备运行环境，也不用开终端。想用别的照样可以改选。
- 第一步的说明不再出现 Node.js、Python 这些词：图形界面写「点开就能用」，命令行工具在 Windows 上写「会自动帮你准备运行环境」。
- 点「安装」装好之后，引导会自己走到下一步，不用再点「下一步」。
- 装好后如果已经用当前账号自动连好了，「确认连接」这一步直接跳过，最后一步顶上会写一句「已用当前账号连好」，想换密钥或模型点旁边的「点这里」。已有别家配置、用的是官方账号或手动填的密钥时，照旧停下来让你看一眼。

## 开发

- 第十一批候选 1 + 3。`registry/tools.ts` 新增 `guideRecommendedTool = 'codexDesktop'`（Windows 与 Mac 同一个，协调者拍板），`registry/tools.test.ts` 钉住它在两个平台都可见且不依赖运行环境。
- `StartGuide.tsx`：新增纯函数 `defaultGuideRoute`（恢复的进度优先，否则推荐项；推荐项在当前平台不可见时不选，即 Linux）与 `guideCanSkipConnect`（仅 `source === 'account'` 且已准备好、已连上）。选项排序推荐项置顶，卡片名旁加 `Pill`「推荐」（`guide-recommended`）。
- 「准备工具」里安装成功后记下路线，等检测结果跟上、`readiness.prepared` 变真时由 effect 替用户推进到下一步（能跳就直接到「开始使用」）；换路线、离开这一步都会作废这个记号。最后一步在跳过时显示 `guide-connected-note`，里面的「点这里」走 `onConfigure`。
- 测试：`StartGuide.test.tsx` 补默认项与跳过判定；`features/auth/browser-check.mjs` 里依赖「无默认项」「装完手点下一步」「三次下一步到最后一步」的几条按新行为改写；`e2e/onboarding-smoke.mjs` 的首屏断言改成默认选中推荐项（Linux 仍无默认）。
