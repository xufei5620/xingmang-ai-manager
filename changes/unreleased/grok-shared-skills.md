## 用户

- 扩展的技能页里，Grok 也能看到给 Codex 导入的技能了（新版 Grok 本来就会用它们），同名的只列一份。

## 开发

- `provider-extensions.ts` 的 `skillRoots`：Grok 除了 `~/.grok/skills` 再扫 `~/.agents/skills`（Grok 1.0.52 起也读这个目录，
  2026-10-22 用真程序核过，`xingmang-ai-skill.ts` 那段注释写的就是它）。Grok 一个名字只认一份，所以 `~/.agents/skills` 里的技能
  跟 Grok 别的目录（`~/.grok/skills`、项目 `.grok/skills`）同名时不列；两边都有时 Grok 自己认哪份没核过，这里按 `~/.grok` 那份优先（推断）。
  星芒生图技能 `images` 两个目录各装一份，以前 Grok 只列 `~/.grok` 那份，现在也只列一份；`~/.grok` 是同步之后才建的电脑，
  Grok 页以前看不到这个技能，现在能看到。Grok 的技能照旧只读，不给装、卸、启停按钮；Codex 用户层导入就是放进 `~/.agents/skills`（`codex-extensions.ts` `importSkill`）。项目里的 `.agents/skills` Grok 读不读没核过，不扫。
