## 用户

- Codex 的配置文件少了括号这类写坏的情况，首页现在也能认出来，点「修好它」就好。

## 开发

- `electron/codex-config-syntax.ts`：表头少了 `]`（`[model_providers.x` 直接换行、`[[a]` 只收一半）报的
  `Unexpected character, expected whitespace, . or ]` 加进「Codex 也拒绝」的名单。数组少 `]`、内联表少 `}` 报的
  `Invalid character, expected whitespace, comma (,) or close bracket (])` 和 `Unterminated inline array`，
  @iarna/toml 碰上 Codex 认的 TOML 1.1 写法（跨行或带注释的内联表、数组里紧挨着结尾三引号的引号）也报这两句，
  所以只在字符串、注释以外的括号确实没配上时才算坏（新函数 `bracketsPairUp`：读得了的文件括号一定配得上）。
  以前这几类不在名单里，首页照旧「待连接」、没有「修好它」，配置窗里「保持当前」那条修复也走不到（Mac 验收 R2，
  报告 #1925、#1921）。「修好它」的只去坏行（`lineLocalTomlErrors`）也认表头少 `]`：连它下面那张表一起去掉，
  别的设置照留；数组、内联表没收尾的报错落在下一行，不救，照旧整份重建。
- 每句都配了 Codex 也拒绝的用例，连同不该报坏的 TOML 1.1 写法和 120 份随机样本，在沙箱里拿 Codex 0.169.0
  （`codex features list`）逐条跑过：该拒绝的全拒绝，该读的全读得了。
