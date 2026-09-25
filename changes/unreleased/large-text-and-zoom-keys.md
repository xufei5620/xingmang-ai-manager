## 用户

- 设置 →「外观」多了「大字」开关：打开后说明文字和小字都会大一些，看着更轻松，页面排版不变。默认关着。
- 按 Ctrl（Mac 上是 ⌘）加号 / 减号可以在 90%、100%、110% 之间放大缩小界面，按 Ctrl 0 恢复自动；每按一下，屏幕下方都会说现在是多少。以前 Windows 上按这几个键没反应。

## 开发

- `app-settings.ts` / `ipc.ts`：设置新增可选字段 `largeText`，只把 `true` 落盘，缺省 = 关；`settings:save` 对非布尔值报「大字设置」格式错误。
- `src/renderer-v2/styles/tokens.css`：`:root[data-large-text="true"]` 把 `--font-small*` / `--font-micro*` 四个变量各加 1px，正文与布局不动。
- `features/app/ui-scale-shortcut.ts`：Ctrl/⌘ + `+`/`=`/`-`/`0` 的识别与步进（「自动」按 100% 算），App 统一拦截并 `preventDefault`，Mac 菜单里的「放大 / 缩小」不再单独改缩放；设置页通过新的可选属性 `uiScale` 跟上快捷键改过的值。快捷键说明补了两行。
