## 用户

- Claude Code 的模型临时用不了时会自动换一个接着答：正在用的 Claude 模型临时用不了时，
  会换成账号里另一个 Claude 模型把这一轮答完，不再卡着重试三分钟左右、最后报一句英文错；余额不够、请求太频繁时不换。

## 开发

- 星芒写 Claude Code 的 `settings.json` 时多写一项 `fallbackModel`（备用型号，产品负责人 2026-10-26 同意）：
  `cli-model-defaults.ts` 的 `resolveClaudeFallbackModels` 从这个密钥列着的 Claude 型号里挑最多两个，先是同系列版本最新的
  另一版（Opus 5.5 → Opus 5），再是另一档里最新的（Opus、Haiku 配 Sonnet，Sonnet 配 Opus），不挑 Haiku，挑不到就不写。
- 沙箱本地假接口实测 2.1.302、2.1.310：主型号回「无可用渠道」503、上游 500/502/529、找不到型号 404 时，有备用 1～2 秒内换过去
  答完这一轮（备用也用不了就试下一个）；没有备用要重试 10 次、约 3 分钟后报英文错。额度不足 403、限流 429 不换。
- 写入规矩同 `/model` 菜单（`claude-model-picker.ts`）：只在没写过、或是本软件照这份型号清单给原来那个型号写的时改（配置窗口里
  换了型号，备用跟着换），客户自己写的不动；打开前核对、开机那轮（`config-save-service.ts` 的 `syncClaudeFallbackModels`）
  给老配置补上，开机那轮 Claude Code 开着或看不出就这次不写、先备份。切回官方账号不收回（里面是官方型号名，认不出是谁写的）。
