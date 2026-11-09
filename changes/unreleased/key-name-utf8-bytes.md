## 用户

- 在个人中心新建或修改密钥时，中文名字超过 16 个字，点保存会被拒。现在名字框按实际能保存的长度收：中文打到 16 个字、英文打到 50 个字母就打不进去了，不用再白填一遍。

## 开发

- 星芒账号（new-api）的密钥名称按 UTF-8 字节数限 50（`controller/token.go` AddToken / UpdateToken 的 `len(token.Name) > 50`），
  手填这条路以前按字数数：输入框 `maxLength={50}`、`ipc/parsers/account-keys.ts` 的 `requiredString(…, 50)`、
  `new-api-client.ts` 的 `validateKeyEditorInput` 都放行 17～50 个汉字，到站点才被拒。现在 `catalog.ts` 导出
  `utf8Length` / `truncateUtf8` / `accountKeyNameMaxBytes`，主进程两处改按字节；密钥页名称框用 `account-center.ts` 的
  `limitKeyNameEdit` 照 maxLength 的样子收一次编辑（只截这次新打或贴进来的那段，已有的字和光标不动），拼音输入法
  拼字期间不截、选完字再收。历史账号（sub2api）的 100 照旧。界面文字没有改。审查编号 ZW-1（0.2.24 深查·中文路径编码）。
