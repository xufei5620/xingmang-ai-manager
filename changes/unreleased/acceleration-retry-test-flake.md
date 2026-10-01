## 开发

- 修稳 `electron/acceleration-development-host.test.ts` 的「proxy recovery retries」一组：等待真实
  lstat 的那几处原来最多等 200 轮 setImmediate 就往下走，CI 忙时下一次推进假时钟发生在重试定时器
  排上之前，最后一次重试永远不触发（10-1 #730、#734 各红一次）。改成等到那一步真的发生，
  只保留「确认不再发生什么」那几处的有界等待；被测代码不变。
