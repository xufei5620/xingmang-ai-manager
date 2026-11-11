## 用户

- 装工具时下载更耐等：装 Claude Code、Codex 这些工具，或者装 Node.js、Git、Python 的时候合上盖子，过几分钟再打开，
  不会再一醒来就报「下载太久没有完成，超时中止」、换个地方从头下，睡着的那段不算时间，醒来接着下；Windows 上自动装 Git、Python 时，
  网慢也不会下到 10 分钟就被掐断、从头再下了，只要还在下就接着等，3 分钟一点数据都没有才算没下好，和装 Node.js 一样。

## 开发

- 睡眠深查 G1：Mac、Windows 上主进程的计时器和 `performance.now` 睡着那段也算，睡着时到期的一醒全部补触发，所以装工具时合盖超过 3 分钟一醒就判「卡住」。新模块 `awake-deadline.ts`：每 15 秒看一次单调时钟，两次之间隔了 60 秒以上（或时钟往回跳）当睡眠，只记一个间隔进总时长，「多久没进展」从这一刻重新算；规则同 `updater.ts` 下载看门狗那套。用在三处：`createNpmDownloadStallWatch`（npm 解析和下载的 3 分钟卡住检测，量盘那一拍和量完那一刻都看表）、`download-retry.ts` 的 `createDownloadDeadline`（Node.js、Git、Python 安装包的 3 分钟卡住和 30 分钟兜底），以及 `runCommand` 新的可选项 `timeoutExcludesSleep`，`executeNpm` 的三步（解析 10 分钟、下载 30 分钟、装到本机 5 分钟）和 Node.js MSI / winget、Git、Python 安装程序的 15 分钟都打开它。时限的数没变，醒着的时间照旧有上限；计时器一直很晚才轮到时每拍仍记一个间隔，兜底不会永远到不了。Linux 的单调时钟本来就不算睡眠，结果不变。没改上屏文字。
