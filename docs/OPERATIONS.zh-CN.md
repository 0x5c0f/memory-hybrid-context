# 运维手册

本文档用于日常运行、排障、巡检和维护 `memory-hybrid-context`。

和完整部署文档不同，这里按“场景”组织命令，重点是快速定位问题并恢复服务。

## 1. 基础状态巡检

优先执行这组命令：

```bash
openclaw plugins doctor
openclaw plugins info memory-hybrid-context --json
openclaw mhm stats
openclaw mhm project current
```

重点关注：

1. 插件是否已启用
2. `records` 是否异常波动
3. `indexing.pending` 是否长期堆积
4. 当前项目绑定是否符合预期

## 2. 网关与插件加载问题

如果怀疑插件未生效：

```bash
openclaw gateway restart
openclaw plugins doctor
openclaw plugins info memory-hybrid-context --json
systemctl --user status openclaw-gateway.service
```

排查要点：

1. Gateway 是否已重启成功
2. 插件是否在 allowlist 中
3. 插件 manifest 和入口是否可加载

## 3. 写入链路问题

如果发现“写入后搜不到”或“记忆没有落库”：

1. 先确认记录是否存在
```bash
openclaw mhm list --status all --limit 20
```

2. 检查暂存区
```bash
openclaw mhm stage-list --limit 20
```

3. 手动提交暂存
```bash
openclaw mhm idle-run --idle-minutes 1 --limit 20
```

4. 手动提交测试记录
```bash
openclaw mhm commit "运维写入测试。" --type decision --session ops-write-verify
```

5. 检查是否可读
```bash
openclaw mhm list --session ops-write-verify --status all --limit 10
```

如果确认是测试记录，收尾时清理：

```bash
openclaw mhm purge --session ops-write-verify
```

## 4. 检索与召回问题

如果“明明写了，但搜不到”：

1. 先按宽条件查
```bash
openclaw mhm search "关键词" --status all --limit 20
```

2. 再按类型收窄
```bash
openclaw mhm search "关键词" --type decision --status all --limit 20
```

3. 再按作用域排查
```bash
openclaw mhm list --scope mem://user/default --status all --limit 20
```

4. 如果怀疑被覆盖或被治理状态过滤：
```bash
openclaw mhm search "关键词" --status superseded --limit 20
openclaw mhm search "关键词" --status forgotten --limit 20
openclaw mhm search "关键词" --status expired --limit 20
```

5. 如果怀疑前端上下文被误捕获为长期记忆：
```bash
openclaw mhm search "Sender (untrusted metadata)" --status all --limit 20
openclaw mhm search "Use the following recalled memories as historical context only" --status all --limit 20
```

处理建议：

1. 若有命中，先按返回的记录 `id` 执行 `purge`
2. 再确认当前版本是否已包含前置清洗逻辑
3. 清理后重新跑一轮前端召回测试，确认污染不再复现

## 5. 索引队列问题

如果搜索结果异常，优先看索引队列：

```bash
openclaw mhm index-list --limit 20
openclaw mhm index-list --status failed
```

常用处理：

1. 手动消费
```bash
openclaw mhm index-run --limit 32 --drain
```

2. 重试失败任务
```bash
openclaw mhm index-retry --limit 20
```

3. 全量重建
```bash
openclaw mhm index-rebuild --limit 100
```

如果只需要补原生向量层：

```bash
openclaw mhm index-rebuild --limit 100 --missing-native
```

## 6. 一致性问题

这是排查“静默错误”的首选入口。

1. 查看一致性报告
```bash
openclaw mhm consistency-report --limit 50 --format markdown
```

2. 预演修复
```bash
openclaw mhm consistency-repair --limit 50 --dry-run
```

3. 执行修复
```bash
openclaw mhm consistency-repair --limit 50
```

4. 如需连失败任务一起处理
```bash
openclaw mhm consistency-repair --limit 50 --retry-failed
```

重点看这些字段：

1. `recordIssues`
2. `orphanIndexes`
3. `missingRecordJobs`
4. `staleRunningJobs`
5. `failedJobs`

## 7. 归档问题

如果怀疑归档文件缺失、错位、残留：

1. 先看统一归档巡检
```bash
openclaw mhm archive-report --limit 50 --format markdown
```

2. 查看孤儿归档
```bash
openclaw mhm archive-orphan-audit --limit 50
```

3. 预演隔离
```bash
openclaw mhm archive-orphan-quarantine --limit 50 --dry-run
```

4. 执行隔离
```bash
openclaw mhm archive-orphan-quarantine --limit 50
```

5. 查看隔离区
```bash
openclaw mhm archive-quarantine-list --limit 50
```

6. 恢复隔离文件
```bash
openclaw mhm archive-quarantine-restore --limit 50 --dry-run
openclaw mhm archive-quarantine-restore --limit 50
```

7. 彻底清理隔离文件
```bash
openclaw mhm archive-quarantine-purge --limit 50 --dry-run
openclaw mhm archive-quarantine-purge --limit 50
```

## 8. 治理问题

如果记录被错误治理，按状态分别处理。

1. 软删除记录
```bash
openclaw mhm forget --id <recordId>
```

2. 恢复过期记录
```bash
openclaw mhm restore --id <recordId>
```

3. 批量恢复
```bash
openclaw mhm restore --type todo --limit 20
```

4. 清理过期记录
```bash
openclaw mhm cleanup --dry-run --limit 20
openclaw mhm cleanup --limit 20
```

5. 硬删除记录
```bash
openclaw mhm purge --id <recordId>
```

## 9. 向量后端与性能问题

当 `store.vector.backend = ann-local` 时，优先看这两条：

```bash
openclaw mhm ann-stats
openclaw mhm ann-health
```

重点关注：

1. `level`
2. `score`
3. `probePerBand`
4. `recommendedProbePerBand`
5. `hottestBuckets`
6. `embeddingMode`（应为 `openai-compatible` 才是标准语义 embedding）
7. `embeddingDimensions`（应大于 0，且稳定）
8. `embeddingSuccessCount`（持续增长说明 embedding 请求正常）
9. `embeddingFallbackCount`（持续增长说明正在退化到 hash）

`ann-health` 只做本地计算，不会增加模型 token。

## 10. 数据导出与迁移

迁移前建议先导出：

```bash
openclaw mhm export --status all --format json --output /tmp/mhm-export.json
openclaw mhm export --status all --format markdown --output /tmp/mhm-export.md
```

导入前先预演：

```bash
openclaw mhm import --input /tmp/mhm-export.json --dry-run
```

确认后再正式导入：

```bash
openclaw mhm import --input /tmp/mhm-export.json
```

### 10.1 旧 `session-memory` Markdown 迁移到本插件

如果用户是在运行一段时间后才启用 `memory-hybrid-context`，旧 `workspace/memory/*.md` 不会自动回灌，需要手动迁移。

插件内置了两个辅助脚本：

1. `scripts/legacy-session-memory-export.js`
   - 把旧 Markdown 解析为 `mhm import` 可直接使用的 JSON
2. `scripts/seed-legacy-session-memory.js`
   - 生成随机历史记忆样本，用于联调和人工回归

一键迁移命令（推荐）：

```bash
# 先预演
openclaw mhm migrate-session-memory \
  --input ~/.openclaw/workspace/memory \
  --session-prefix legacy-session \
  --scope mem://user/default \
  --output /tmp/mhm-legacy-import.json \
  --dry-run

# 确认后执行正式迁移
openclaw mhm migrate-session-memory \
  --input ~/.openclaw/workspace/memory \
  --session-prefix legacy-session \
  --scope mem://user/default \
  --output /tmp/mhm-legacy-import.json
```

常用流程：

```bash
# 1) （可选）先生成一批随机旧格式记忆，用于迁移联调
node scripts/seed-legacy-session-memory.js \
  --output-dir ~/.openclaw/workspace/memory-legacy-seed \
  --days 2 \
  --records-per-day 4 \
  --prefix LEGACY-SYNC

# 2) 把旧 Markdown 导出为 import JSON
node scripts/legacy-session-memory-export.js \
  --input ~/.openclaw/workspace/memory-legacy-seed \
  --output /tmp/mhm-legacy-sync-import.json \
  --session-prefix legacy-sync \
  --scope mem://user/default \
  --verbose

# 3) 先 dry-run 再正式导入
openclaw mhm import --input /tmp/mhm-legacy-sync-import.json --dry-run
openclaw mhm import --input /tmp/mhm-legacy-sync-import.json
```

导入后建议立即验证：

```bash
openclaw mhm search "LEGACY-SYNC" --status all --limit 10
openclaw mhm list --session legacy-sync-$(date +%F) --status all --limit 20
openclaw mhm consistency-report --limit 50 --format markdown
```

## 11. 例行巡检建议

建议至少按以下频率做：

1. 每次版本变更后
   - 执行 [RELEASE_CHECKLIST.zh-CN.md](./RELEASE_CHECKLIST.zh-CN.md)

2. 每周一次
   - `stats`
   - `ann-health`
   - `archive-report`
   - `consistency-report`

3. 每次批量迁移后
   - `import --dry-run`
   - `consistency-report`
   - `archive-report`

## 12. 推荐排障顺序

如果只想按最短路径排障，建议固定使用这个顺序：

1. `openclaw mhm stats`
2. `openclaw mhm consistency-report --limit 50 --format markdown`
3. `openclaw mhm archive-report --limit 50 --format markdown`
4. `openclaw mhm ann-health`
5. 必要时再执行 `consistency-repair`

这套顺序可以覆盖大部分问题，而且不会修改数据，适合作为第一轮诊断。
