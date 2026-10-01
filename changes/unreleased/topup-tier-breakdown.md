## 用户

- 充值页的快捷金额改成一档一张卡，每张写清到账多少、实付多少、送百分之几，没有活动的档位写「无赠送」。自定义金额输入后，下面也同样列出到账、实付和赠送。实付按当前账号现在的价格算，后台调了价格或活动，这里会跟着变。
- 当前账号如果是全部档位统一多送（比如每档都送 10%），每张卡也会写出到账多少、送多少。
- 支付方式不再显示「alipay」这类英文代码，改成「支付宝」「微信支付」。

## 开发

- 新增 `src/renderer-v2/features/account/topup-tier.ts`：`describeTopupTier` 把档位、服务端试算的实付和赠送规则换成卡片三行；`useTopupQuotes` 逐档串行调用 `account:quote-topup`（最多 16 档，自定义金额停止输入 500ms 后再算）。充值信息一重新加载，旧结果整批作废；试算失败时只隐藏实付，不报错。易支付渠道的实付标 ¥，其余渠道不标币种。
- 两种账号的档位含义不同。new-api 档位是到账额度，赠送读 `discount`。Sub2API 档位是实付金额，到账 = 档位 × `balance_recharge_multiplier`。`NewApiTopupInfo` 新增可选字段 `creditMultiplier`，只由 `sub2api-relay-backend.ts` 的 `parseTopupInfo` 填写，非有限正数一律按 1 处理，和 Sub2API 自己的页面一致。
- 新增 `features/account/payment-method-label.ts`：后台没填显示名、接口只回渠道代码时，换成中文渠道名。没有新增 IPC 通道。
