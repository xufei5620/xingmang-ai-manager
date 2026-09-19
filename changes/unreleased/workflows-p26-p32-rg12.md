## 开发

- `.github/workflows/release-build.yml` 不再把 `workflow_dispatch` 的输入直接插进 PowerShell 脚本正文（P-26）。
  `${{ inputs.confirm_version }}` / `${{ inputs.update_url }}` 是在 PowerShell 解析之前做的文本替换，含单引号的
  输入能闭合字符串字面量并执行后面的内容——而这台 runner 正是唯一能读到签名证书的地方。版本确认、自签名
  更新源拦截、产物校验和三步改为在 `env:` 里绑定后读 `$env:`，语义不变。
- `.github/workflows/quality.yml` 的 `audit` 作业去掉 `setup-node` 的 `cache: npm`（P-32）。这个作业从来不跑
  `npm ci`——`npm audit` 只读 `package-lock.json`——所以那份缓存没有恢复目标，只是每次多一次查表和上传。
- `linux-test` 新增一步 `npm run check:legacy`，第一次让回滚渲染层的构建链路进 CI（R-G12）。新脚本是
  `cross-env XINGMANG_RENDERER=legacy vite build --outDir dist-legacy`，不打包、不碰 `dist/`，产物已进 `.gitignore`；
  `vite.config.ts` 里那张 React 18 alias 表只在 `XINGMANG_RENDERER=legacy` 时生效，此前 `tooling/legacy-renderer/`
  的固定运行时腐坏、或 `src/` 长出 React 18 满足不了的 import，都要等到真的需要回滚那天才会暴露。Linux 上约 1 秒。
- `scripts/release-workflow-config.test.cjs` 与 `scripts/ci-workflow-config.test.cjs` 各补门禁：发布工作流的任何
  `run` 块不得再出现 `${{ inputs.* }}`；`audit` 作业不得声明依赖缓存；`check:legacy` 必须恰好在一个作业里跑，
  且不得退化成打包或写进 `dist/`。
