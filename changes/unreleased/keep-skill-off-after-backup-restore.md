## 用户

- 选着 ChatGPT 账号时在「备份」页恢复一份以前的星芒配置，里面自己关掉的「星芒AI」技能，之后改用当前账号不会再被打开。

## 开发

- #834 F07 的收尾：技能记录 `xingmang-ai-skill-state.json` 不跟着备份恢复。选着 ChatGPT 账号、记录还记着「切回星芒时打开」时，
  在备份页恢复一份星芒配置、里面技能关着，改用当前账号会原样拿它当星芒配置，以前会把客户的关打开一次。
  `adoptRestoredConfig` 加可选的 `fromBackupsPage`（只有 `backups:restore` 传），这时调
  `adoptRestoredXingmangAiSkillOff` 把记录改成 false，和 Gemini 那笔一样放在登记来源之前。切换失败的回滚不传：
  它恢复的是切换前那一刻，记录本来就对得上。在星芒下记着 true 说明上次没打开成，那个关多半就在恢复出来的这份里，照旧打开。
