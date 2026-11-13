## 开发

- 技能文件夹名带中文、空格、括号（「写作助手」「my-skill (1)」）不再报「Skill 目录名包含不支持的字符」，落地时换个名字存进去
  （表单输入校验审查 F7）：先按 SKILL.md 里的 `name`，没写或转出来是空的再按文件夹名，都转成小写英文字母、数字加 `-`
  （全角字母、带音调的字母先换成普通字母，最长 64 字，碰上 `con`、`nul` 这类 Windows 设备名就跳过）；全是中文、转不出字的，
  用文件夹名算一个固定的 `skill-` 加 8 位短码，同一个文件夹再导一次落在同一处、照旧报「已存在」，不同的中文文件夹也不会撞到一起。
  本来就合规的文件夹名原样用、不读 SKILL.md，行为不变；换出来的名字照旧过 `SKILL_DIRECTORY_PATTERN`，越界检查、已存在检查、
  复制时逐个文件的检查都不动。「已存在」报的名字跟列表上显示的一致（SKILL.md 的 `name`，没写才是文件夹名）。
  Codex、Claude Code、Grok 三家都走 `skillImportTarget`，一起生效；没改界面文字（`buildRenamedSkillDirectoryName`，`codex-extensions.ts`）。
