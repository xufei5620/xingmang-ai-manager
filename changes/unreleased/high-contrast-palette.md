## 用户

- 设置里的「高对比度」现在真的会让整个界面变清楚：文字、按钮、输入框、选中的菜单、开关和进度条
  都换成对比更强的颜色，灰掉的按钮也还看得清字。以前打开它几乎看不出变化。开着高对比度时，
  界面皮肤会暂时统一成高对比配色，关掉就恢复你选的皮肤。
- 在 Windows 里打开「高对比度」主题后，软件里的开关、进度条、当前所在的页面、选中的选项
  不会再整块消失，会按系统配色画出边框和高亮。

## 开发

- `styles/tokens.css` 在原型那两条 `.hc` 规则（原样保留，`provenance.test.ts` 钉着）之后，追加
  `:root[data-theme].hc[data-skin]` 两条，把高对比从 6 个变量扩成每个主题一整套不透明色值，覆盖
  皮肤会设置的全部颜色变量（开启时皮肤配色让位）。新增 `styles/contrast-tokens.test.ts`：纯计算校验三级文字
  4.5:1、主按钮/强调色/选中行 4.5:1、状态色含淡底 4.5:1、边框与焦点环 3:1，并检查每套皮肤的
  颜色变量都被覆盖。
- 新增 `styles/contrast.css`（`main.tsx` 最后一个样式导入，每条规则带 `:root` 以压过懒加载页面
  的样式）：一段 `@media not (forced-colors: active)` 管应用内高对比（主按钮去渐变、禁用态
  改 60% + 虚线边、开关描边、选中态加实线标记、焦点环 3px、链接下划线、去掉星空与侧栏渐变），
  一段 `@media (forced-colors: active)` 管 Windows 系统高对比（弹窗/提示/品牌图块补真实边框，
  选中态用 `Highlight`/`HighlightText` 并 `forced-color-adjust: none` 避开文字背板，开关、
  进度条、状态圆点、下拉箭头改用系统色重画）。原 `components.css` 末尾两条 `.hc` 规则并入该文件。
- 新增浏览器用例 `styles/contrast.browser-check.mjs`（进 `test:v2:browser`），用 Chromium 的
  forced-colors 模拟核对计算样式；Windows 真机各主题下的样子仍需人工截图对照。
- 与原型差异已记入 `docs/UI-V3.1.1-V2-REBUILD.md`「规范差异」；`ui-spec/` 未改。
