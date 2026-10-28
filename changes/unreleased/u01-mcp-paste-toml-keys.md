## 开发

- #1489 U01：`features/extensions/mcp-paste.ts` 的 TOML 子集解析加固。表一律不带原型（`Object.create(null)`），
  取表、查重只认自有键（`Object.hasOwn`）；键名是 `__proto__`、`constructor`、`prototype` 的整段不认，和别的认不全的
  TOML 一样回「没认出这段配置」。顺带 `toString`、`valueOf` 这类普通对象上本来就有的名字，现在当普通键名认。
  粘贴框是 0.2.23 新功能，没有对客户可见的变化。
