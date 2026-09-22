## 开发

- 修掉 `electron/system-service.test.ts` 的测试隔离问题：最新版探测的总预算
  （`settleLatestVersionProbes`）到点只是不再等，底下那批探测在丢掉结果之后仍会接着
  往备用源发请求——npm 的镜像→官方源那一跳要等满 10 秒，Grok 的 x.ai→GCS 那一跳同理，
  都落在用例结束之后，于是串进后面用例的 `vi.stubGlobal('fetch')` 桩里，让无关 PR 假红
  （2026-09-22 PR #326 的 Windows vitest 分片中过一次：三条 `/latest` 撞上一条断言
  「不该发请求」的安装用例）。
- 做法：预算到点时 abort 一个交给探测那侧的 `AbortController`。手里那次请求照旧跑完
  （它还可能给缓存留下有用的结果），但不再启动备用源；半途撂挑子攒出来的失败不写
  缓存，免得按失败 TTL 钉住让紧跟着的那次扫描连试都不试。超时时长、用户看到的结果
  都没动。`fetchGrokStableVersion` 新增可选 `abandonedSignal`，缺省即旧行为。
- 补了两条钉住的用例：离线预算那条用例在断言之后打掉挂住的请求并核对请求数不再增长
  （去掉实现里的守卫就会红），以及 `settleLatestVersionProbes` 只在预算真到点时
  abort 传入的控制器。
