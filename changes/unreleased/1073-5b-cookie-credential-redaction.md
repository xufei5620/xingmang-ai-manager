## 开发

- 运行日志、反馈报告、诊断导出和启动失败日志的脱敏补认 `cookie`、`credential` 两个名字（连同复数
  `cookies`、`credentials`）：`redaction-patterns.ts` 的 `redactSecretFields` 三条按名字认的规则（带双引号、
  带单引号、不带引号）都加上，跟崩溃报告原来就抹的一样。`Cookie:` 头另加一条：好几对 `名=值` 用 `; `
  连着时整串抹掉，原来那条遇到 `;` 就停，只抹得到第一对；`HttpOnly` 这类不带 `=` 的标记和后面的句子照旧
  留着（#1073 第 5 条 b）。
