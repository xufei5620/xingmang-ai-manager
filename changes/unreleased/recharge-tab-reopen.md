## 用户

- 个人中心里切到「我的订单」等其它分页后，回首页再点「充值」，现在会回到充值那一页，不再停在上次的分页。

## 开发

- 全面检测 Q29。`App.tsx` 的 `accountTab` 改成带序号的 `{ sequence, value }`（同 `tutorialTopic`），经 `BusinessPage` 的 `accountTabRequest` 传给 `AccountPage` 新增的可选 `tabRequest`，同一个分页再点名也会切过去。`app-check.mjs` 加回归用例。
