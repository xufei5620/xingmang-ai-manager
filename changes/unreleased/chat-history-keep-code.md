## 用户

- 聊天记录里 AI 写的代码，重开软件以后不再被改坏：`const token = req.headers.authorization`、`password: string`、`api_key = os.environ["OPENAI_API_KEY"]` 这类只是写着名字的代码原样保存，导出的文件里也一样。真正贴进来的密钥、密码照旧存成「[密钥未保存]」。

## 开发

- 聊天页深查 C3 / 汇总决定单 D104，放宽脱敏，yoyo 11-09 亲手打字「脱敏放开」。`src/renderer-v2/features/chat/storage.ts` 的「名字 = 值」那条（`namedSecretValue`）以前不看值、一律换掉，现在交给 `redactNamedSecretValue` 判断：类型名、标识符和点连起来的一串、函数调用和取下标、`$变量` / `${{ … }}` / `%VAR%` / `<占位>`、中文文案、引号里的普通句子原样留；字母数字混着 5 位以上、带符号、十六进制、UUID、bcrypt、碎驼峰的随机字母串照旧换。引号里按词看，一个词像密钥就整段换。
- 反引号也当引号（`` Authorization: `Bearer ${token}` ``）；右引号后面紧跟的 `)`、`}` 算在值里，换掉时留着末尾的收尾符号，`OpenAI(api_key="…")` 存成 `OpenAI(api_key=[密钥未保存])`，存两次结果一样（以前引号后面跟着符号时第二次存会再吞一截）。
- `sk-`、`Bearer 长串`、网址里的 `?token=`、共用表那几类都没动。对拍 100 万条：没有名字关键词的文本新旧逐字一样；没有新增「存两次结果不同」。放开的边界：只有字母、不带数字的值 12 位以下不遮（`password: sunshine` 原样存），不带数字的随机字母串长的也偶尔认不出（16 位约 6%、20 位以上约 4%），带数字的 4 位以下不遮。
