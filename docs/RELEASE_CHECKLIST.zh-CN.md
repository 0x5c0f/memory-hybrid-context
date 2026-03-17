# 发布前检查清单

本文档用于在插件代码、配置、索引策略或治理规则发生变更后，快速完成一轮发布前验收。

目标不是替代完整测试，而是用最短路径确认：

1. 插件能正常加载
2. 主链路未损坏
3. 一致性仍然成立
4. 归档治理未出现新异常

## 1. 启动检查

1. 重启 Gateway
```bash
openclaw gateway restart
```

2. 检查插件是否可加载
```bash
openclaw plugins doctor
openclaw plugins info memory-hybrid-context --json
```

通过标准：

1. `plugins doctor` 无插件错误
2. `memory-hybrid-context` 处于已启用状态

## 2. 基础状态检查

1. 查看主状态
```bash
openclaw mhm stats
```

2. 查看项目绑定
```bash
openclaw mhm project current
```

3. 查看向量健康
```bash
openclaw mhm ann-health
```

通过标准：

1. 命令都能正常返回
2. `indexing.pending` 不应长期堆积
3. `annHealthLevel` 可以是 `warn`，但不应出现明显异常恶化

## 3. 写入与检索快速回归

1. 写入一条临时测试记录
```bash
openclaw mhm commit "发布前快速回归测试。" --type decision --session release-check-verify
```

2. 检索该记录
```bash
openclaw mhm search "发布前快速回归测试" --type decision --status all --limit 5
```

3. 查看该记录
```bash
openclaw mhm list --session release-check-verify --status all --limit 5
```

通过标准：

1. 能写入
2. 能搜索到
3. 能在列表里看到

## 4. 索引检查

1. 查看索引队列
```bash
openclaw mhm index-list --limit 10
```

2. 主动跑一轮消费
```bash
openclaw mhm index-run --limit 16 --drain
```

通过标准：

1. 队列可被正常消费
2. 不应出现持续堆积的 `failed` 或卡住的 `running`

## 5. 一致性检查

1. 先看一致性报告
```bash
openclaw mhm consistency-report --limit 50 --format markdown
```

2. 如有问题，先预演修复
```bash
openclaw mhm consistency-repair --limit 50 --dry-run
```

3. 必要时执行修复
```bash
openclaw mhm consistency-repair --limit 50
```

通过标准：

1. `recordIssues = 0`
2. `orphanIndexes = 0`
3. `missingRecordJobs = 0`
4. `staleRunningJobs = 0`
5. `failedJobs = 0`

## 6. 归档治理检查

1. 查看归档巡检
```bash
openclaw mhm archive-report --limit 50 --format markdown
```

2. 如需进一步排查
```bash
openclaw mhm archive-orphan-audit --limit 50
openclaw mhm archive-quarantine-list --limit 50
```

通过标准：

1. `linkedIssues = 0`
2. `orphanedFiles = 0`
3. `quarantinedFiles` 允许非零，但必须是已知的、已解释的

## 7. 收尾清理

1. 删除本轮临时测试记录
```bash
openclaw mhm purge --session release-check-verify
```

2. 再次确认系统回到干净状态
```bash
openclaw mhm consistency-report --limit 50 --format markdown
```

## 8. 版本打包

如果这是一次正式版本发布，完成上面的检查后，再执行正式打包：

```bash
cd ~/.openclaw/extensions/memory-hybrid-context
bash scripts/release-package.sh
```

执行后应检查：

1. 是否生成了一份新的不可变快照
2. `latest` 包是否已刷新
3. `latest.json` 是否指向最新快照

建议执行：

```bash
cat ~/.openclaw/extensions/memory-hybrid-context-latest.json
ls -la ~/.openclaw/extensions/memory-hybrid-context-latest.bundle.tar.gz
ls -la ~/.openclaw/extensions/memory-hybrid-context/releases/0.1.0/
```

通过标准：

1. `releases/<version>/` 下新增一份带时间戳的快照包
2. `memory-hybrid-context-latest.bundle.tar.gz` 存在
3. `memory-hybrid-context-latest.json` 中的 `sourceSnapshot` 指向刚生成的快照

如需了解完整发布策略：

1. [RELEASE_STRATEGY.zh-CN.md](./RELEASE_STRATEGY.zh-CN.md)

## 9. 可选归档

如果这是一次正式版本发布，建议再补一份基线快照：

```bash
openclaw mhm consistency-report --limit 50 --format markdown --output /tmp/mhm-consistency-release.md
openclaw mhm archive-report --limit 50 --format markdown --output /tmp/mhm-archive-release.md
```

## 10. 最终判定

满足以下条件即可判定“可发布”：

1. 插件加载正常
2. 写入、检索、读取、索引链路正常
3. 一致性报告主要故障项全为 `0`
4. 归档报告无新增异常
5. 测试记录已清理
6. 已完成正式打包，且 `latest` 与最新快照指向一致
