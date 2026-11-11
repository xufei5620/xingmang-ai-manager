## 开发

- 发版工作流的 Linux 测试拆成两个并行作业（测试和CI深查 CI-2）：原来 `linux-checks` 一个作业串行跑完
  typecheck、npm test、整条 test:v2:browser 和 test:ui，11-02 Linux 补发那次（运行 41408530433）用了 42.2
  分钟，上限 45；开着 Linux 时它一超时，选「全部平台」的这一版 Windows 和 Mac 也发不出去。现在 test:v2:browser
  的夹具那半照 quality.yml 的切法放进新作业 `linux-renderer-v2-browser`（两片，用同两条
  `test:v2:browser:fixture:linux:N` 脚本），和 `linux-checks` 同时跑，`linux-build` 两个都过了才出包。
  `linux-checks` 预计约 22 分钟，上限 45 → 60；每片约 10 分钟，上限 45。一项测试没少、没有哪项跑两遍，
  `scripts/publish-workflow-config.test.cjs` 钉住两边实际派出去的合起来正好是整条 test:v2:browser、各片和 PR 上同一组脚本、
  上限要盖住 apt 最坏用时再留增长。
