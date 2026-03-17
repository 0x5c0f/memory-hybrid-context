# 版本归档说明

## 版本信息

1. 插件：`memory-hybrid-context`
2. 版本：`0.1.0`
3. 归档日期：`2026-03-03`
4. 日常部署包：
   - `memory-hybrid-context-latest.bundle.tar.gz`
5. 不可变快照：
   - `releases/0.1.0/` 下的时间戳包

## 版本定位

这是第一阶段完成版的归档快照。

该版本已经具备：

1. 可作为 OpenClaw 主记忆插件运行
2. 完整的写入、召回、治理、索引和迁移能力
3. 完整的部署、验收、运维、归档文档
4. 一致性审计与一致性修复能力
5. 可直接在新环境解压部署的整包归档

## 当前基线摘要

1. `recordIssues = 0`
2. `orphanIndexes = 0`
3. `failedJobs = 0`
4. `archiveIssues = 0`
5. `quarantinedFiles = 1`
6. `annHealthLevel = warn`

说明：

1. 当前数据一致性正常
2. 当前归档链路正常
3. `annHealthLevel = warn` 是性能观察项，不是阻断故障

## 归档内容

当前版本目录已包含：

1. `README.zh-CN.md`
2. `CHANGELOG.zh-CN.md`
3. `DEPLOY_AND_TEST.zh-CN.md`
4. `RELEASE_CHECKLIST.zh-CN.md`
5. `OPERATIONS.zh-CN.md`
6. `BASELINE_2026-03-03.zh-CN.md`
7. `consistency-report.json`
8. `consistency-report.md`
9. `archive-report.json`
10. `archive-report.md`
11. `openclaw.plugin.json`
12. `package.json`

## 使用建议

如果以后需要回看或恢复这一版，优先使用：

1. `README.zh-CN.md` 查看整体说明
2. `DEPLOY_AND_TEST.zh-CN.md` 执行完整部署与测试
3. `RELEASE_CHECKLIST.zh-CN.md` 做快速验收
4. `OPERATIONS.zh-CN.md` 做日常运维与排障
5. `BASELINE_2026-03-03.zh-CN.md` 对照基线

## 后续发布策略

后续不再通过覆盖同名时间戳包保留版本。

统一策略是：

1. 每次发布生成一份不可变快照
2. 同时刷新一个固定名称的 `latest` 包

详见：

1. [RELEASE_STRATEGY.zh-CN.md](./docs/RELEASE_STRATEGY.zh-CN.md)
