## 开发

- 0.2.25 总单第 75 项（死代码报告 H4）：删掉 `electron/system-service.ts` 里没接上的 `assertNpmReleaseIntegrityMatches`。
  它只比单个包的包名、版本和 SHA-512，客户的安装流程从没调过它，只有测试在调；读到它的人容易以为镜像对账就这么点，
  或者把它当成现成的闸门拿去复用。真正生效的两道都在 `cli-install-service.ts`，一道没动：
  `assertNpmReleaseMatchesOfficialLock`（官方源的依赖图和官方发布信息对上）、`assertNpmPackageLocksEquivalent`
  （镜像解出的整棵依赖图逐项和官方源比，版本、SHA-512 都要一样）。
- `electron/system-service.test.ts` 里原来那条用例一半测官方源查询不跟重定向、一半测这个函数；删掉后一半，
  前一半留着（这是查询那个函数唯一的用例）。镜像依赖图对不上要拒绝，原来就有 `assertNpmPackageLocksEquivalent` 的用例钉着。
