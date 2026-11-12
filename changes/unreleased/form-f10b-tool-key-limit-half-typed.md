## 开发

- 0.2.24 深查「查表单输入校验」F10-b：个人中心「每个工具的额度上限」框打成「-」「1e」这种半截数时，
  数字框交出来的值是空的，以前当成留空，一点「保存」就把上限改成不限额、还提示「额度上限已保存」。
  现在点保存那一刻现读框的 `validity.badInput`（`features/account/ToolKeyLimits.tsx`；从空打成「-」值没变、
  onChange 不来，所以不能靠 onChange 记），是半截数就交给 `parseManagedCliKeyLimitAmount` 报现成的那句
  「请填写大于 0 的上限金额，留空表示不限额。」，不发保存（`electron/account-key-quota.ts`）。真留空照旧是不限额。
  不加新字、不加新通道；用户可见条目已满 60 条，这件不另写用户条目。
