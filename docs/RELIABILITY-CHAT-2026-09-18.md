# 聊天存储可靠性修复记录

日期：2026-09-18。范围为 renderer-v2 聊天存储、旧版迁移、自动保存及相关测试；保留工作区既有改动，不访问生产模型，不提交或推送。

## 阶段一：基线与问题定位

- 基线：`npx vitest run src/renderer-v2/features/chat/state.test.ts`，17 项通过。
- 基线：`node --test src/renderer-v2/features/chat/browser-check.mjs`，20 项通过，全部请求由本地 fixture 模拟。
- `storage.ts` 读取 `content`、`reasoning`、草稿及 system prompt 时通过 `slice(0, 40000)` 截断，消息通过 `slice(-101)` 丢弃较早内容；对话数量通过 `slice(0, 50)` 截断，重复/无效记录通过 filter 静默丢弃。
- 旧版导入只取最后 100 条消息并截断 system prompt；超限/解析失败返回 null，无法与无旧数据区分。
- `useChatController.ts` 在异步身份读取和旧版导入完成前就允许自动保存；迁移尚未完成可能先建立空的 v2 记录，下一次载入不再尝试导入。
- 两个历史域别名同时存在时仅采用较新的整个 workspace，另一个别名的独有会话不会显示。

## 阶段二：实现

- 已移除内容、思考、草稿、system prompt、标题和模型信息的读取截断，以及每会话历史消息和图片引用的静默截取。
- 保持 4 MB UTF-8 / 50 个对话整体预算。超过预算、无效消息或重复标识显式报错，原 localStorage 原子值保持不变；读取警告继续禁用当前窗口自动保存和卸载保存。
- 旧 v1 迁移改为在经过账号域校验的首次存储读取中同步完成，避免异步 `readSession` 与空记录自动保存竞争。仍只允许原 xm 账号域，保留 v1 原始 key。
- 合并两个历史域别名的独有对话，同 ID 不同内容分配新 ID 保留分支，同时保留较旧来源非空草稿及 system-only 草稿。超出预算时显示迁移未保存，并保留内存中全部记录和两个源 key。
- 存储错误优先显示，写入失败说明原始记录仍保留及窗口内容尚未保存。未变更生产请求的上下文/消息限制。

## 阶段三：验证

- `state.test.ts` + 新增 `storage.test.ts`：37 项通过，覆盖 >40,000 字内容/思考、Unicode、350 条历史、10 张图片引用、旧数据直接读取后回写、v1 210 条迁移、system-only 迁移、别名冲突分支、4 MB/50 对话拒绝以及配额失败保留旧值。
- `node --test src/renderer-v2/features/chat/browser-check.mjs`：25 项通过（原 20 项 + 5 项回归），包含 StrictMode 长正文/思考读取、自动保存与刷新完整往返，已有超限 v2 原值保留，v1 同步迁移与失败防空值回写，新生成 >4 MB 输出在窗口中保留并报错，以及切换账号卸载时不覆盖之前的原值。
- `npx tsc -p tsconfig.renderer-v2.json --noEmit`：通过。
- `git diff --check`：相关修改无空白错误。新增/修改文件均使用 UTF-8 无 BOM。

## 范围与限制

- 修复针对当前 renderer-v2 客户端读取、迁移和保存链路，没有更改旧 renderer 的独立 `src/ai-chat-state.ts` 持久化实现，也没有扩大模型请求上下文限制。
- 已经被旧版本覆盖、且任何保留来源都没有的字节无法从截断文本恢复。本次可防止尚完整存在于 v2/v1/历史别名 key 的数据在读取和迁移中继续丢失。
- 超过 4 MB 或结构不兼容的源保留在原 localStorage key，界面明确提示且禁止当前窗口自动覆盖；没有自动删除、后台压缩或隐式清空。

## 补充：自动配置结果复核

- 只读审查覆盖主进程配置归属指纹、串行写入、账号切换和 renderer 自动配置链路。未发现可复现的自动覆盖手动 Key 缺陷；发现后端拒绝写入后，renderer 会把当前可用的手动配置误报为账号配置成功。
- `account-bootstrap.ts` 现在优先保留后端失败结果，只有后端明确报告成功、复核配置可用且来源为 `account` 时才记为成功并清除手动来源标记。后端结果缺失或互相冲突也不会报告成功。
- 新增 7 项回归，覆盖后端失败但当前 manual/unknown 配置可用、后端成功但归属为 manual/unknown/缺失、可用账号配置缺少成功结果，以及成功与失败同时返回。原成功用例同步提供主进程实际返回的账号归属字段。
- 验证：`npx vitest run src/renderer-v2/features/tools/account-bootstrap.test.ts --no-file-parallelism --testTimeout=30000`，14 项通过；`npx tsc -p tsconfig.renderer-v2.json --noEmit` 通过；相关 diff 无空白错误。未修改 browser fixture。
- 另发现 CI 纯文档分类会跳过随应用打包的 Skill Markdown 和 `docs/canvas-third-party.json` 校验输入，已交由主代理单独修复，不在本次 bootstrap 修改范围内。
