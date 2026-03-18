# 变更日志

本文档记录 `memory-hybrid-context` 的阶段性演进，用于后续版本维护、回归排查和发布说明。

## 2026-03-18 v0.2.0 单网关强隔离落地

本次更新包含运行时代码与文档双更新，不是纯设计稿。

### 1. 运行时能力

已实现：

1. 插件版本升级到 `0.2.0`
2. 新增 `isolation.mode`（默认 `agent`）与 `isolation.defaultAgentId`（默认 `main`）
3. 主库核心表新增 `agent_id` 并补齐索引
4. 写入/检索/治理链路统一按 `agent_id` 过滤（`global` 兼容模式除外）
5. 归档路径改为按 agent 分桶：`<archive.dir>/<agentId>/...`
6. 工具与 hook 链路自动注入 `agentId`
7. CLI 增加 `--agent-id` 口径切换
8. 记忆归档文件统一落在 `records/` 子目录（`agent` 模式：`<archive.dir>/<agentId>/records/...`；`global` 模式：`<archive.dir>/records/...`）
9. `archive.dir` 默认值调整为 `~/.openclaw/memory-hybrid/archive`（避免与 `workspace` 会话工作区语义混用）

### 2. 模块级改造

已完成改造的核心模块：

1. `src/core/*`（record/staging/store/project）
2. `src/retrieval/retriever.js`
3. `src/indexing/indexing-manager.js`
4. `src/governance/*`（archive/consistency/lifecycle）
5. `src/interfaces/*`（hooks/tools/cli/services/schema）
6. `src/operations/*`（import-export/stats-policy）

### 3. 文档同步

同步更新：

1. `README.zh-CN.md`
2. `docs/CONFIG_REFERENCE.zh-CN.md`
3. `docs/DEPLOY_AND_TEST.zh-CN.md`
4. `docs/TESTING.zh-CN.md`
5. `docs/AGENT_ISOLATION_DESIGN.zh-CN.md`

更新目标：

1. 把 `v0.2.0` 从“设计稿语义”切换为“已实现语义”
2. 提供可直接执行的多 agent 隔离部署与验收路径

## 2026-03-17 语义检索增强

本次更新把“可选高质量语义检索”补齐到可落地状态。

### 1. embedding provider

新增 `openai-compatible` embedding 配置与调用链路：

1. `store.vector.embedding.mode = openai-compatible`
2. `baseURL / model / apiKey|apiKeyEnv / dimensions / timeoutMs`
3. 向量生成统一接入 provider（写入与查询同链路）

### 2. 回退策略可控

新增：

1. `store.vector.embedding.fallbackToHash`
   - `true`：可用性优先（默认）
   - `false`：语义一致性优先

并改进缓存策略：

1. 仅缓存成功 embedding 结果
2. 失败回退结果不再长期缓存，避免“故障后长期语义降级”

### 3. 可观测性增强

`mhm stats / ann-stats` 新增 embedding 运行指标：

1. `embeddingMode`
2. `embeddingModel`
3. `embeddingRequestCount`
4. `embeddingSuccessCount`
5. `embeddingFallbackCount`
6. `embeddingLastError`

### 4. 文档更新

同步更新：

1. `README.zh-CN.md`
2. `docs/DEPLOY_AND_TEST.zh-CN.md`
3. `docs/CONFIG_REFERENCE.zh-CN.md`
4. `docs/TESTING.zh-CN.md`
5. `docs/OPERATIONS.zh-CN.md`

### 5. 历史记忆迁移脚本

新增两份运维脚本，覆盖“晚装插件”的历史回灌场景：

1. `scripts/legacy-session-memory-export.js`
   - 把旧 `workspace/memory/*.md` 转为 `mhm import` JSON
2. `scripts/seed-legacy-session-memory.js`
   - 生成随机旧格式记忆样本，用于联调和人工回归
3. `openclaw mhm migrate-session-memory`
   - 一键执行“解析旧 Markdown + 导入插件记忆库”（支持 `--dry-run`）

### 6. 官方 memory slot 对齐

为对齐 OpenClaw 插件规范，本插件增加了 `kind: "memory"` 声明（manifest + runtime）。

1. 好处：由 `plugins.slots.memory` 统一选择 memory 插件，避免并行接管。
2. 配置迁移：`plugins.slots.memory` 需改为 `"memory-hybrid-context"`。
3. 注意：若仍为 `"none"`，memory-kind 插件不会加载。

## 2026-03-03 第一阶段完成版

这是当前的第一阶段完成基线。插件已经可以作为 OpenClaw 的主记忆插件使用。

### 1. 架构定位

从最初的概念设计，收敛为一个“分层双轨记忆插件”：

1. 双轨存储
   - 结构化主库（SQLite）
   - Markdown 归档

2. 分层记忆
   - `L0 / L1 / L2`

3. 双作用域
   - `user`
   - `project`

4. 可插拔向量后端
   - `hash-vec`
   - `sqlite-vec`
   - `ann-local`

### 2. 记忆主链路完成

实现了完整的主链路：

1. `agent_end` 自动暂存
2. `/new` / `/reset` 自动提交
3. `idle commit`
4. `before_agent_start` 自动召回
5. 分层预算注入

### 3. 数据模型与治理完成

实现了完整治理能力：

1. TTL
2. `cleanup`
3. `purge`
4. `restore`
5. `forget`
6. 按 `status` 查询与列表

并支持：

1. `active`
2. `superseded`
3. `expired`
4. `forgotten`

### 4. 索引与检索完成

实现了：

1. 混合检索
   - FTS
   - 向量检索

2. 异步索引队列
   - `index_jobs`
   - `index_failures`
   - 消费 / 重试 / 重建

3. 一致性修复后使用的新 FTS 表
   - `memory_fts_docs`

### 5. 向量后端演进

经历了三步：

1. `runtime-hash` 占位实现
2. `sqlite-vec` 原生函数模式接入
3. `ann-local` 升级为可用 LSH 本地后端

当时的阶段性调优基线是：

1. `backend = ann-local`
2. `mode = ann-local-lsh`
3. `probePerBand = 1`

### 6. `ann-local` 增强

本阶段完成：

1. 持久化桶表
   - `memory_ann_buckets`

2. 多探针查询
   - 当前每个 band 额外探测 `1` 个 probe

3. 健康诊断
   - `ann-stats`
   - `ann-health`

4. 调参建议
   - 输出建议 `probePerBand`

### 7. 运维与迁移完成

实现了完整运维闭环：

1. `stats`
2. `policy`
3. `routing`
4. `breakdown`
5. `search`
6. `list`
7. `get`
8. `export`
9. `import`
10. `import --dry-run`

### 8. 归档治理完成

实现了归档治理闭环：

1. 关联归档校验
2. 缺失归档修复
3. 孤儿归档扫描
4. 孤儿归档隔离
5. 隔离区列表
6. 隔离区恢复
7. 隔离区清理
8. `archive-report`

并支持导出：

1. JSON
2. Markdown

### 9. 一致性审计与修复完成

新增：

1. `consistency-report`
2. `consistency-repair`

覆盖：

1. 主记录与索引一致性
2. 孤儿索引
3. 索引任务状态
4. 归档摘要
5. `ann-local` 健康摘要

### 10. 结构重构完成

从超大单文件重构为模块化结构。

当前核心模块：

1. [archive-governance.js](./src/governance/archive-governance.js)
2. [consistency-manager.js](./src/governance/consistency-manager.js)
3. [indexing-manager.js](./src/indexing/indexing-manager.js)
4. [record-manager.js](./src/core/record-manager.js)
5. [retriever.js](./src/retrieval/retriever.js)
6. [lifecycle-manager.js](./src/governance/lifecycle-manager.js)
7. [project-manager.js](./src/core/project-manager.js)
8. [staging-manager.js](./src/core/staging-manager.js)
9. [import-export-manager.js](./src/operations/import-export-manager.js)
10. [stats-policy-manager.js](./src/operations/stats-policy-manager.js)
11. [store-query-manager.js](./src/core/store-query-manager.js)
12. [vector-health.js](./src/retrieval/vector-health.js)
13. [tool-registration.js](./src/interfaces/tool-registration.js)
14. [cli-registration.js](./src/interfaces/cli-registration.js)
15. [service-registration.js](./src/interfaces/service-registration.js)
16. [hook-registration.js](./src/interfaces/hook-registration.js)
17. [plugin-schemas.js](./src/interfaces/plugin-schemas.js)

### 11. 文档交付完成

已交付：

1. [README.zh-CN.md](./README.zh-CN.md)
2. [DEPLOY_AND_TEST.zh-CN.md](./docs/DEPLOY_AND_TEST.zh-CN.md)
3. [RELEASE_CHECKLIST.zh-CN.md](./docs/RELEASE_CHECKLIST.zh-CN.md)
4. [BASELINE_2026-03-03.zh-CN.md](./docs/baselines/2026-03-03/BASELINE_2026-03-03.zh-CN.md)

### 12. 当前已知状态

当前基线并非“终极封顶版”，但已满足第一阶段目标：

1. 可作为主记忆插件运行
2. 可完成完整部署与验收
3. 可做归档与一致性自检

当前仍需持续观察的项：

1. `annHealthLevel = warn`
2. `quarantinedFiles = 1`

这两项不属于当前版本阻断问题：

1. `annHealthLevel = warn` 是性能观察项
2. `quarantinedFiles = 1` 是归档治理待处理项

## 后续版本建议

如果继续进入第二阶段，建议优先级如下：

1. 基于真实数据继续调优 `ann-local` 的桶策略
2. 补更细的监控与告警
3. 根据实际迭代需要补版本化迁移脚本
