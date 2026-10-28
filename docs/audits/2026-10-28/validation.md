# 本轮验证记录及限制

此页区分固定全量基线、提交前增量和额外审查夹具。测试通过只证明已有断言通过，不等于本报告列出的反例已被覆盖；本PR没有修复这些缺陷。

## 环境

- Windows，测试运行时 Node **v22.23.4**（与仓库 `.nvmrc` 同主版本）；Vitest **4.1.12**。
- 独立工作区；根和canvas按锁文件执行 `npm ci`，没有改锁。测试使用已存在且版本一致的 Electron **43.8.3** 和 Playwright 对应 Chromium；没有安装客户工具。
- 自动化模型/账号/支付调用全部mock；本次线上调查只有先前授权的只读配置与日志查询，未用生产作为测试后端。

## 固定全量基线 c21be274：两条必需检查均通过

`npm run typecheck`：四段 TypeScript 检查完成，退出码0。

`npm test`：完整执行 Vitest、scripts、posttest:scripts、browser，最终退出码0。原汇总：

```text
Test Files  709 passed | 5 skipped (714)
     Tests  13852 passed | 513 skipped (14365)

test:scripts:      tests 740 / pass 684 / fail 0 / skipped 56
posttest:scripts:  tests 361 / pass 358 / fail 0 / skipped 3
test:browser:     tests 24 / pass 24 / fail 0 / skipped 0
```

跳过项按仓库平台/能力门控执行，不能记作已验收的 Mac/Linux/提权场景。没有重用前轮 worker 异常的失败结果冒充通过，也没有以“环境原因”忽略这次必需检查失败。

## 提交前增量 444ecc18

工作区已快进到该提交，5个变化文件的字节与审查Git blob一致，产品源码没有本地修改。

- `npm run typecheck` 再次完成，退出码0。
- `npm test` 在该提交再次运行：Vitest **709文件通过/5跳过，13852用例通过/513跳过**；scripts **684通过/56跳过**，posttest:scripts **358通过/3跳过**，这些阶段均0失败。随后标准browser首业务页面也遇到下述U06，90秒/3次导航失败，后续同前置故障后停止；这次整条命令**没有取得退出码0**。
- 保留原缓存与失败证据后，在同一`444ecc18`的新隔离工作区按同一锁文件安装根和canvas依赖，原样运行`npm run test:browser`：**24通过、0失败、0跳过，退出码0**。没有改测试断言、产品代码、锁或解析配置。该复测只补browser阶段，不把它伪称第二次完整`npm test`成功。
- 另用当前新hook原文运行5个隔离浏览器场景：N2反例＋找到旧任务对照、R28-4反例＋两正常对照，全部取得预期观察。详见 [增量页](latest-delta.md)。临时fixture显式隔离React版本；不能替代原始整套浏览器验收。

### 额外原始视频浏览器套件没有通过

执行原命令 `node --test --test-concurrency=1 src/renderer-v2/features/video-studio/browser-check.mjs`，前5个静态断言通过，首个实际页面用例在3次导航、90秒后失败：

```text
A React Element from an older version of React was rendered.
video studio page did not finish installing within 90000ms after 3 navigations
```

后续页面出现相同挂载错误，为避免把同一前置故障重复等待一整套，停止了本次已核对身份的测试进程树；整体未完成，不能记作通过。已确认 U06：根开发依赖扫描混入canvas的React18，Node22新缓存和原开发配置也复现。生产build模块图未混用，不声称发布包故障；详见 [依赖解析专项](domains/dev-react.md)。未通过更改产品代码、锁文件或测试断言去压绿。

这条video命令不在 `npm test` 的三个浏览器套件中；但本轮后续标准account-commerce套件也受到U06影响，故不能说它仅影响额外验收。新隔离目录的标准browser通过说明状态/入口图会影响结果，**不能证明根因已消除**。`npm run test:v2` 全套没有执行，不作通过声明；本PR只改文档，并以草稿保留这项验证不稳定，尚未宣称最新基线完整回归稳定全绿。

## 定向复现与覆盖检查

各域报告明确标注当前反例、历史复用和未执行场景。当前新执行包括：配置事务并发/回滚、导出流失败、窗口状态、遥控关闭与UTF-8分块、U01输入副作用、U02更新失败后的画布、U03辅助服务清理、U04总超时、U05托盘恢复，以及legacy账号隔离。它们使用临时文件、原模块与mock边界，没有真实安装、关机、渠道发送或付费。

legacy支持测试另有55文件、453通过的隔离记录；不与完整Vitest汇总相加，以免重复计算。临时浏览器harness的首次React双版本或selector装配失败已在各专项说明，修正harness后取得证据不等于原始产品验收套件通过。

全量2383文件的分配/最终账本/当时工作树字节核对无缺失、重复、哈希不符；后续444增量5文件另列。117个历史ID全部保留且恰好一行，78编号均有当前状态、优先级、证据、修复与验收链接。公开报告本地链接及固定源码链接做了路径/行号核验，未修安全条目只留摘要。

## 未执行且不能据此宣称通过

三平台真实安装/卸载、厂商应用更新和退出写回、真实Windows关机/UAC、Mac签名与代理授权、客户切线后的真实Codex完成、线上视频账单对账、所有依赖的在线漏洞数据库扫描均未执行。已有单测/模拟证据不覆盖这些外部边界。
