## 用户

- 给某个工具设的额度用完后，软件不会再换用这个工具以前那把不限额的密钥；撤销密钥、查密钥列表时网络出了岔子，也会先停下说清楚，不会悄悄把额度放开。

## 开发

- #475（D01）：按工具额度在四种情况下被放开，统一改成拿不准就不放开。`new-api-client.ts` 的 `hasExhaustedCappedCliKey` 加 `newerThanId`、`sub2api-relay-backend.ts` 的 `provisionCliKey` 同理：同名 Key 里比用完的上限更旧的不再被复用；`ipc.ts` 撤销前读不到本机工具密钥记录时，设了限制的 Key 不撤；撤销报错后只有列表里还看得见这把 Key 才删记下的限制；`chat-credential-coordinator.ts` 聊天 Key 401 后查不了列表就保留本机 Key 报错，不再当成「没用完」去换新的。
