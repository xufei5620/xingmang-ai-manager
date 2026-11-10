## 开发

- 星芒账号密钥名称超长时的报错统一成 yoyo 11-10 批的那句（「名称超长改」），放在 `catalog.ts` 的 `accountKeyNameTooLongMessage`，
  `new-api-client.ts` 的 `validateKeyEditorInput` 和 `ipc/parsers/account-keys.ts` 的 `parseAccountKeyCreateInput` 共用。原来前者说
  「不能超过 50 个字符」（站点数的是字节，中文其实只能 16 个字），后者把超长和别的毛病一起报成「密钥名称格式错误」。入参检查的超长判断挪到
  `requiredString` 前面，英文超 50 个也报新句；不是字符串、空的、带 NUL、两头空格撑过原始长度的照旧报「格式错误」。能存的名字没变：仍按
  UTF-8 50 字节，历史账号的 100 和说法照旧。名称框本来就打不进超长的字，客户平时看不到这句，所以没写「## 用户」。
  冻结的旧界面 `KeyEditorDialog.tsx` 那句不动。出处 `0.2.24-深查/Fable复查.md` 第二节第 9 条。
