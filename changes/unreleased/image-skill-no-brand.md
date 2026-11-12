## 开发

- 生图技能（`bundled-skills/xingmang-ai`）里会被 AI 读到、转述给客户的字不再出现「星芒」和站点地址：技能说明、画图工具说明、
  「点名认不出型号」列表和出错提示的主语改成「当前账号」「管理工具」；`references.md` 不再写死 `xm.solov.cc`，改成用 `config.json`
  的 `baseUrl`（历史账号照它手写请求不再连错站）；示例输出名 `xingmang-cat.png` 改成 `cat.png`。客户没改过的技能文件下次登录同步自动换成新字。
- 名字不动：技能名 `images`、画图工具名 `xingmang-image`（改名会让客户在 Claude Code 里设的「每次先问 / 不许用」对新名字失效）、
  `.xingmang-managed.json`、旧文件夹「星芒AI」；画图工具的三个站点白名单和命令行脚本的兜底地址也不动。
  `scripts/xingmang-image-mcp.test.cjs` 新增一条钉住：两份说明不含「星芒」和站点地址，两个脚本不含「星芒」、站点地址只剩白名单和兜底那几个。
