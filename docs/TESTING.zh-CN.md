# 测试手册

本文档用于验证插件是否真正可用，而不只是“已加载”。

测试分成两类：

1. 命令侧测试
2. 前端对话召回测试

## 1. 测试前准备

先确认插件已启用：

```bash
openclaw gateway restart
openclaw plugins doctor
openclaw plugins info memory-hybrid-context --json
openclaw mhm stats
```

通过标准：

1. `status = loaded`
2. `enabled = true`
3. `cliCommands` 包含 `mhm`
4. `hookCount > 0`

## 2. 命令侧基础测试

### 2.1 手动写入

写入 3 条基础测试数据：

```bash
openclaw mhm commit "当前测试标签是 doc-e2e-check。" --type profile --session doc-e2e-seed
openclaw mhm commit "当前测试项目使用 memory-hybrid-context 作为主记忆插件。" --type decision --session doc-e2e-seed
openclaw mhm commit "当前测试项目的数据库文件路径是 /home/cxd/.openclaw/memory-hybrid/main.sqlite。" --type entity --session doc-e2e-seed
```

### 2.2 检索

```bash
openclaw mhm search "doc-e2e-check" --status all --limit 5
openclaw mhm search "主记忆插件" --type decision --status all --limit 5
openclaw mhm search "数据库文件路径" --type entity --status all --limit 5
```

通过标准：

1. 每条都能搜到结果

### 2.3 列表与读取

```bash
openclaw mhm list --session doc-e2e-seed --status all --limit 10
openclaw mhm get <record-id>
```

通过标准：

1. 能看到记录
2. `get` 能读到 `l0 / l1 / l2`

### 2.4 语义检索测试（embedding）

这个测试用于确认你不是只在跑 `hash` 向量。

先看运行状态：

```bash
openclaw mhm stats
```

通过标准（至少满足前两条）：

1. `vector.embeddingMode = openai-compatible`
2. `vector.embeddingModel` 与你的配置一致
3. `vector.embeddingDimensions > 0`
4. `vector.embeddingSuccessCount > 0`
5. `vector.embeddingFallbackCount` 持续为 0（或非常低）

写入一条语义测试数据：

```bash
openclaw mhm commit "我们下个季度会把订单服务拆分为独立微服务，以降低主应用耦合。" --type decision --session semantic-e2e
```

用近义问法检索（避免逐字命中）：

```bash
openclaw mhm search "下季度计划把下单模块单独拆出来减少耦合" --type decision --status all --limit 5
```

通过标准：

1. 可以召回上面那条 `decision`
2. 结果不是只靠完全相同词面

## 3. 索引与一致性测试

### 3.1 索引队列

```bash
openclaw mhm index-list --limit 20
openclaw mhm index-run --limit 16 --drain
```

### 3.2 一致性

```bash
openclaw mhm consistency-report --limit 50 --format markdown
```

理想目标：

1. `recordIssues = 0`
2. `orphanIndexes = 0`
3. `failedJobs = 0`

若不为 0：

```bash
openclaw mhm consistency-repair --limit 50 --dry-run
openclaw mhm consistency-repair --limit 50
```

### 3.3 旧记忆迁移联调（session-memory -> mhm）

这个测试用于验证“用户晚装插件时，如何把旧 `workspace/memory/*.md` 回灌进来”。

推荐直接跑一键迁移命令：

```bash
openclaw mhm migrate-session-memory \
  --input ~/.openclaw/workspace/memory-legacy-seed \
  --session-prefix legacy-sync \
  --scope mem://user/default \
  --output /tmp/mhm-legacy-sync-import.json \
  --dry-run

openclaw mhm migrate-session-memory \
  --input ~/.openclaw/workspace/memory-legacy-seed \
  --session-prefix legacy-sync \
  --scope mem://user/default \
  --output /tmp/mhm-legacy-sync-import.json
```

如果你要分步观察解析结果，可使用下面的脚本流程：

```bash
# A. 生成随机旧格式记忆（可重复执行）
node scripts/seed-legacy-session-memory.js \
  --output-dir ~/.openclaw/workspace/memory-legacy-seed \
  --days 2 \
  --records-per-day 4 \
  --prefix LEGACY-SYNC

# B. 导出为 mhm import JSON
node scripts/legacy-session-memory-export.js \
  --input ~/.openclaw/workspace/memory-legacy-seed \
  --output /tmp/mhm-legacy-sync-import.json \
  --session-prefix legacy-sync \
  --scope mem://user/default \
  --verbose

# C. dry-run + 正式导入
openclaw mhm import --input /tmp/mhm-legacy-sync-import.json --dry-run
openclaw mhm import --input /tmp/mhm-legacy-sync-import.json
```

通过标准：

1. `dry-run` 返回 `created > 0`
2. 正式导入返回 `imported > 0`
3. marker 检索可命中，例如：
```bash
openclaw mhm search "LEGACY-SYNC" --status all --limit 10
```

## 4. 前端对话召回测试

这是最重要的测试。只有这里成功，才说明插件在真实对话里生效。

### 4.1 测试数据

建议先写入这组更稳定的数据：

```bash
openclaw mhm project use frontend-e2e --name "前端联调测试"
openclaw mhm commit "当前联调标签是 frontend-e2e-memory-check。" --type profile --session frontend-e2e-seed-1 --l0 "联调标签" --l1 "当前联调标签是 frontend-e2e-memory-check。" --l2 "当前联调标签是 frontend-e2e-memory-check，用于前端验证用户侧记忆召回。"
openclaw mhm commit "当前联调项目使用 memory-hybrid-context 作为主记忆插件。" --type decision --session frontend-e2e-seed-1 --l0 "主记忆插件" --l1 "当前联调项目使用 memory-hybrid-context 作为主记忆插件。" --l2 "当前联调项目使用 memory-hybrid-context 作为主记忆插件，当前正式测试版本为 0.1.0。"
openclaw mhm commit "联调项目的数据库文件路径是 /home/cxd/.openclaw/memory-hybrid/main.sqlite。" --type entity --session frontend-e2e-seed-1 --l0 "数据库路径" --l1 "联调项目的数据库文件路径是 /home/cxd/.openclaw/memory-hybrid/main.sqlite。" --l2 "联调项目的数据库文件路径是 /home/cxd/.openclaw/memory-hybrid/main.sqlite，当前用于存储 memory-hybrid-context 的主记录和索引状态。"
openclaw mhm commit "2026-03-03 已完成 memory-hybrid-context 0.1.0 正式包联调准备。" --type event --session frontend-e2e-seed-1 --l0 "联调完成" --l1 "2026-03-03 已完成 memory-hybrid-context 0.1.0 正式包联调准备。" --l2 "2026-03-03 已完成 memory-hybrid-context 0.1.0 正式包联调准备，可在前端通过自然语言触发记忆召回。"
```

### 4.2 前端提问样例

在前端直接问下面这些句子。

#### 样例 A：用户侧记忆

提问：

1. `你还记得当前联调标签是什么吗？`

预期：

1. 回答中包含 `frontend-e2e-memory-check`

#### 样例 B：项目决策

提问：

1. `当前联调项目用的主记忆插件是什么？`

预期：

1. 回答中包含 `memory-hybrid-context`

#### 样例 C：项目实体

提问：

1. `这个联调项目的数据库文件路径是什么？`

预期：

1. 回答中包含 `/home/cxd/.openclaw/memory-hybrid/main.sqlite`

#### 样例 D：项目事件

提问：

1. `2026年3月3日完成了什么联调准备？`

预期：

1. 回答中包含 `memory-hybrid-context 0.1.0 正式包联调准备`

### 4.3 为什么这样问

这些句子故意带了明显的“记忆触发”语气，比如：

1. `你还记得`
2. `当前项目`
3. `之前`
4. `完成了什么`

这种提法更容易触发 recall。

### 4.4 前端上下文污染防护测试

这个测试用于确认：

1. 前端注入的 recall 包不会被反向写进长期记忆
2. 用户的提问句本身不会被误存成 `profile / preference / entity`

建议在完成一轮前端对话后，执行下面的检查：

```bash
openclaw mhm search "Sender (untrusted metadata)" --status all --limit 10
openclaw mhm search "Use the following recalled memories as historical context only" --status all --limit 10
openclaw mhm search "你还记得当前联调标签是什么吗" --status all --limit 10
```

通过标准：

1. 以上三条搜索都应返回 `count = 0`

如果你想进一步确认当前库中没有污染记录，可执行：

```bash
openclaw mhm export --status all --format json --output /tmp/mhm-audit.json
```

然后检查导出结果中是否出现以下片段：

1. `<memory-hybrid-context>`
2. `Sender (untrusted metadata):`

理想情况：

1. 不应在任何正式记忆记录中出现这些片段

## 5. 如果前端没召回，怎么排查

按这个顺序：

1. 先确认记录在库里
```bash
openclaw mhm list --session frontend-e2e-seed-1 --status all --limit 20
```

2. 再确认搜索能命中
```bash
openclaw mhm search "主记忆插件" --type decision --status all --limit 5
```

3. 再看总状态
```bash
openclaw mhm stats
```

4. 再看一致性
```bash
openclaw mhm consistency-report --limit 50 --format markdown
```

5. 最后看前端问法
   - 是否太短
   - 是否没有记忆触发语气

6. 如果怀疑出现前端上下文污染
```bash
openclaw mhm search "Sender (untrusted metadata)" --status all --limit 20
openclaw mhm search "Use the following recalled memories as historical context only" --status all --limit 20
```

若有结果，说明旧污染记录仍在库里，建议按 ID 执行 `purge`

## 6. 治理测试

### 6.1 软删除

```bash
openclaw mhm forget --dry-run --type decision --limit 5
```

### 6.2 清理过期

```bash
openclaw mhm cleanup --dry-run --limit 20
```

### 6.3 恢复

```bash
openclaw mhm restore --type todo --limit 20
```

### 6.4 硬删除

```bash
openclaw mhm purge --dry-run --type decision --limit 5
```

## 7. 收尾清理

测试结束后，建议清理测试数据：

```bash
openclaw mhm purge --session doc-e2e-seed
openclaw mhm purge --session frontend-e2e-seed-1
openclaw mhm purge --session semantic-e2e
openclaw mhm project clear
```

## 8. 最终判定标准

可以判定“插件已真实生效”的最低标准是：

1. 写入成功
2. 命令侧搜索能命中
3. 前端问答能正确复述刚写入的记忆
4. 一致性报告没有主要故障项
