## 开发

- 0.2.24 深查 X-2（`0.2.24-深查/查设置恢复默认和导入导出.md`）：Windows 文本大小调大的电脑，外观「恢复默认」原来一律写
  `largeText: false`，反倒把 D81 替客户开的「大字」关掉，又因为写过 `largeText` 记上了 `textSizeChosen`，之后开机也不再自动开。
  现在 `window:get-capabilities` 的返回多带一个可选的 `largeTextByDefault: true`（主进程按开机读到的 Windows 文本大小，
  由 `window-preferences.ts` 新的纯函数 `shouldDefaultToLargeText` 算：就是「没定过字号的人在这台电脑上开机会不会被 D81 打开」），
  「恢复默认」据此给 `largeText`。没调大、读不到、还没读回来、以及 macOS / Linux 都不带这一项，恢复后照旧是关，和原来一样。
  没加新通道、没改字。
