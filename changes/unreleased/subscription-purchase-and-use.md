## 用户

- 有的账号以前在「充值与订阅」里只能看订阅、不能买，现在点套餐旁的「购买」、选支付方式、付完款就开通。
- 买好订阅后，用得上这份订阅的工具会自动换过去用订阅额度，不用自己改设置，页面上会说换好了哪几个工具；订阅到期后，下次打开软件会自动换回来。本来就是「先扣订阅」的账号，付完款会直接告诉你工具不用重新设置。

## 开发

- `sub2api-relay-backend.ts`：`supportsSubscriptionPayment` 改为 true，`createSubscriptionPayment` 走 Sub2API 现成的 `POST /payment/orders`（`order_type: 'subscription'` + `plan_id`，不带金额，价格由服务端按套餐算）；与充值共用 `orderCheckout` 解析支付地址 / 二维码。`NewApiSubscriptionCheckout` 增加 `qrcode`，`account:create-subscription-payment` 与充值同样先过 `validatePaymentQrCode`。
- Sub2API 的订阅只对订阅分组里的 Key 生效（`canUserBindGroup` / 计费按 Key 的分组）。`managed-cli-groups.ts` 在历史账号上一并读生效订阅，按分组接的上游（认不出再看名字）把对应工具的 Key 换进订阅分组，认到多个不猜；订阅读不到按「没拿到」处理，不当成没有订阅。
- `account-cli-provisioner.ts`：历史账号不再因本机四把 Key 全在就跳过询问服务端；分组读不到时保留缓存里的订阅分组 Key；返回 `regrouped` 列出本轮换了分组的工具。`account-bootstrap.ts` 开机恢复时只改写这些工具，其余已连好的不碰。
- 充值与订阅页：订阅付款到账、兑换码兑成订阅后，历史账号调 App 的 `applySubscriptionToTools`（开机恢复同一档）并报告换好了哪几个工具；星芒账号只提示按扣费偏好先用订阅。
