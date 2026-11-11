## 开发

- 桌面端接入改字（0.2.24 深查决定单 D62 D63，批次 Z21，产品负责人 2026-11-10 北京回「按照你的推荐做」、2026-11-11 北京回
  「决定单照推荐」，字照决定单原文）：OpenCode 保存成功那句改「已经连好了。关掉 OpenCode 再打开就能用；要是你在某个项目里
  单独给 OpenCode 配过模型，那个项目里以你自己配的为准。」（`external-client-route-service.ts`）；Claude Desktop 保存成功那句
  去掉和下面「连接自检：已连好」打架的「尚未验证真实推理连接」，改「已经写进 Claude Desktop。把它完全退出，再从这里点「打开」
  就生效。」（`claude-desktop-config.ts`）；「连接 {桌面端}」弹窗保存后那行配置文件位置收进「查看详情」，默认不展开
  （`ExternalClientDialog.tsx`）；XDG_CONFIG_HOME 不是完整路径时那句改成说怎么修，而且只拦 OpenCode：WorkBuddy 的配置在主目录的
  `.workbuddy` 里、不看这个设置，以前被一起拦下是误伤。
- 检查页「连接自检」：WorkBuddy、OpenCode 用的是客户自己配的别家（配置来源 `other`）时不再标黄，跟「未配置」一样是灰的，
  写「用的是你自己的配置」，不算问题、照旧不拿那把密钥发请求（`external-client-connection.ts`）。Claude Desktop 不在 D63 里，
  照旧标黄。只改字和颜色，小改动不占更新页的条数，所以没写「## 用户」。
