## 开发

- 型号表（#1154 第 2 条）：「问过换新型号」的记录放不下远端默认型号名（带 `: / @ +` 或超过 120 字）时改记名字的
  sha256（`app-settings.ts` 的 `offeredModelUpgradeKey`），拒绝过的客户不再每次开机被再问；记录的读法没放宽，
  放得下的照原样记，老记录照样认。
- 型号表（#1154 第 3 条收紧的那半）：画图、视频、语音、向量和 `codex-auto-review` 这类不能对话的型号
  （`cli-model-defaults.ts` 的 `isNonInteractiveCliModel`）不再被推断成默认，远端型号表把默认、上一代写成它们客户端不认，
  service-status 工作流写的时候直接报错（`scripts/service-status.cjs` 同名函数，测试钉住两边一致）。第 3 条里
  「下架名单剔光时退回账号列着的型号」是放宽，没做。
