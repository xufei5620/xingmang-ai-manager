## 开发

- 余额 store 在快照里记 `reads`（读到过几次，只增不减），`subscribeBalanceReads` 认次数不认 `updatedAt`：
  前后两次读落在同一毫秒时，跟着余额顺带重读用量、订阅、近 7 天的地方以前会漏掉一次。
  `balance-store.test.ts`「tells read listeners once per landed read…」在 linux-test 上偶发红就是这个
  （#1994、#2062 各一次），现在那组用例把 `now` 钉成常数，旧写法每次都红。
