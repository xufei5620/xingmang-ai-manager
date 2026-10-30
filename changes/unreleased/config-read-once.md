## 开发

- 读工具配置时同一份文件只读一遍、只解析一遍（0.2.22 性能体检第 7 条，报告 `/mnt/project-files/0.2.22-性能体检.md`）。界面没变。
  `config:get` 每次把每个工具的配置看一遍，以前 `inspectProviderConfig` 按字段各读各的：Codex 的 `config.toml` 读、解析五遍，
  `auth.json` 读四遍，接着 `managedCliHooksState` 再读一遍主配置；每次读都要走一遍路径检查和单链接复核。开机那阵 `config:get`
  要调两到五次，正好卡在首页渲染的时候。
- `electron/config-files.ts` 新增 `withSharedConfigReads`：包住的这一段里，同一路径的字节、同样内容的 JSON 和 TOML 解析结果
  （连同解析失败的错误）只算一次；出了这一段照旧每次现读。`inspectProviderConfig` 自己包一层，`config-save-service.ts` 的
  `buildConfigSummary` 把看配置和看钩子包在同一段里。包进来的都是只读的同步代码，中间不会写配置，别的代码也插不进来，
  所以读到的就是同一份。`codex-config-syntax.ts` 的 `isCodexConfigBroken` 多一个可选的解析函数参数，判坏时复用同一次解析。
- 沙箱实测（Linux，Codex 配置 120 个信任项目，Claude、Grok 各一份，单次 `getConfig`）：打开配置文件 19 次 → 4 次；
  冷启动第一次 25~38ms → 16~18ms，第二次 10~16ms → 7ms，热了以后 5.7~8.2ms → 3.1~3.4ms。
- 没做：按 mtime 跨次缓存（两次 `config:get` 之间 CLI 自己可能改配置，同一秒内改、大小不变时会读到旧的）；界面开机那几处
  `config:get` 合成一次。
