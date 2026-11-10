## 开发

- 扩展页改字（0.2.24 深查 Z10：W6 W32 W38 W39 W42 W43 D20 D67）：精选的「本应用」改「星芒」
  （`registry/curated-extensions.ts`）；精选出品方改「Anthropic 官方」「MCP 官方」
  （`bundled-catalog/curated-extensions.json`）；自定义连接附加参数、附加设置的报错改成「照提供方说明原样粘贴」
  （`extensions-common.tsx`）；移除确认框按种类分开写：外接工具指回精选或重新填，技能指回「从文件夹导入」
  （`ExtensionsPage.tsx`）。
- D20：缺 uv 时不再叫客户在命令行执行 pip install uv，改成交给客服教，提示里配「找客服」按钮
  （`mcpRuntimeNotice` 多一个 `support`，扩展页和精选页两处提示都给按钮）。
- D67：Codex「自己添加的市场」点「移除市场」先弹确认框（移除 ／ 取消），跟同页删除确认框一个样子；
  e2e 夹具加 `customMarket` 覆盖取消不动、确认才移除。
