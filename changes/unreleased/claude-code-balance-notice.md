## 用户

- 余额用完时，Claude Code 弹的提醒改成说额度不够，点一下直接到充值页。

## 开发

- 终端钩子（`bundled-catalog/cli-hooks/xingmang-hook.cjs`）：余额用完时 Claude Code 的「刚才没回上」通知改说额度不够、点了去充值页。
  Claude Code 2.1.310 连本地假接口实测：new-api 回 403 `insufficient_user_quota`「用户额度不足」时 `StopFailure` 报的是
  `authentication_failed`，照对照表落成 `auth`，通知说「Key 用不了了」、点进去是检查页（主路卡点 F1）。
  现在 `auth` / `unknown` 两类再看一眼 `last_assistant_message` / `error_details`，认出 `relay-quota-failure.ts`
  `balancePattern` 那几句余额原话就改报 `billing`；原文只用来比对，记录里仍只有类别词。Key 失效（401「无效的令牌」）
  和 Key 自己的额度上限照旧报 `auth`，限流、服务出错等别的类别不翻案。Grok 走同一段，载荷里有这两个字段时一起受益（推测，没实测）。
  通知文字没改，用的是已有的 billing 那句。
