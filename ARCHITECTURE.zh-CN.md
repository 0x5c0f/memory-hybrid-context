# Memory Hybrid Context 架构草案

这是一个“分层双轨记忆插件”的实现草案，目标是把当前研究过的三类能力合并到一套更可控的方案里：

1. `memory-core` 的文件可审计性和混合检索
2. `memory-lancedb(-pro)` 的自动捕获和自动召回
3. OpenViking 的分层上下文和显式 `commit`

当前目录是设计与骨架阶段，未接入现有运行配置。

## 1. 目标

插件要同时满足四个目标：

1. 自动沉淀长期记忆，而不是只靠手写 `MEMORY.md`
2. 通过分层注入减少主模型上下文 token
3. 提供可解释、可审计、可人工修正的查询能力
4. 保持本地优先，后端可替换，避免被云服务锁死

## 2. 双轨设计

插件采用“双轨存储”：

1. 结构化轨
   用 SQLite 存结构化记忆、关系、状态、时间、TTL、检索日志。

2. 归档轨
   用 Markdown 存会话归档，保留原始上下文，便于人工审计和迁移。

二者关系：

1. 归档轨保存原始事实来源
2. 结构化轨保存可检索、可合并、可注入的记忆条目
3. 结构化记忆通过 `content_ref` 指向归档内容，而不是反复复制全文

## 3. 分层模型

每条记忆分三层：

1. `L0`
   一句话标题，最适合自动注入。

2. `L1`
   短摘要，默认检索展示层。

3. `L2`
   原始上下文，只在明确需要时展开。

这样做的目的：

1. 默认只注入 `L0/L1`
2. 查询命中后按预算再决定是否拉取 `L2`
3. 把“记住很多事”和“每次带很多 token”拆开

## 4. 归档与提交时机

插件区分“候选提取”和“正式提交”。

### 4.1 候选提取

触发时机：

1. `agent_end`

动作：

1. 只提取候选高价值片段
2. 写入 `staging_candidates`
3. 不直接进入长期记忆

这样可以避免每轮对话都污染长期库。

### 4.2 正式提交

触发时机：

1. `/new`
2. `/reset`
3. 空闲超时（后续实现）
4. 显式调用 `memory_commit`

动作：

1. 写会话归档 Markdown
2. 从 `staging_candidates` 提取候选记忆
3. 生成 `L0/L1`
4. 去重、合并、标记 `superseded`
5. 写入 `memory_records`
6. 更新 FTS / 向量索引
7. 记录 `commit_log`

## 5. 记忆类型

第一版建议支持这些类型：

1. `profile`
2. `preference`
3. `entity`
4. `event`
5. `decision`
6. `pattern`
7. `case`
8. `todo`
9. `other`

区别于现有方案的关键点：

1. 不把所有内容都当成“普通文本记忆”
2. 后续可以为不同类型配置不同召回优先级和覆盖规则

## 6. 检索策略

检索分成五步：

1. 触发判断
   问候、简单确认、纯命令直接跳过。

2. Query Planning
   先判断意图，再确定优先搜索的 `scope` 和 `type`。

3. 结构化过滤
   按 `scope/type/status` 先缩小范围。

4. 混合检索
   FTS + 向量混合，再做去重和排序。

5. 预算打包
   先打包 `L0`，再补 `L1`，最后才考虑 `L2`。

## 7. 作用域

建议统一使用内部 URI 风格的命名空间：

1. `mem://user/{id}/preferences/{id}`
2. `mem://project/{id}/decisions/{id}`
3. `mem://agent/{id}/patterns/{id}`
4. `mem://session/{id}/archive/{id}`

当前草案的落地规则：

1. `user` 仍然是默认主作用域
2. `project` 是增强作用域，但只有在 `projectResolver` 能稳定识别当前项目时才启用
3. `project` 的内部主键使用首次建档后持久化的 UUID，不要求用户手动记住
4. 项目标识通过 `project_registry` 保存，记录：
   - `project_id`
   - `project_key`
   - `project_name`
   - 来源（`manual / workspace / git`）
5. 用户可以显式覆盖当前项目：
   - `openclaw mhm project use <key> --name <name>`
   - `openclaw mhm project clear`
6. 显式覆盖值写入 `plugin_state.active_project_key`，会跨重启保留

这样可以兼顾：

1. 可读性
2. 后续迁移到更复杂上下文数据库
3. 查询过滤和审计

## 8. MVP 范围

第一阶段已经落地到骨架里的内容：

1. SQLite 结构化存储
2. FTS 查询
3. Markdown 会话归档
4. `agent_end` 候选提取
5. `memory_search`
6. `memory_get`
7. `memory_commit`
8. `memory_stats`
9. `memory_stage_list / memory_stage_drop`
10. `project_registry` 与 `project current/list/bind` CLI
11. `plugin_state.active_project_key` 与 `project use/clear` CLI
12. `before_reset` 自动补暂存、自动 commit、自动写会话归档快照
13. `mhm commit / search / get` 终端直连运维命令
14. 真实 `L0/L1/L2` 分层持久化（含自动迁移旧库）
15. 规则型自动分层压缩（按 `type` 自动生成更短的 `L0/L1`）
16. 本地混合检索：FTS + 可插拔向量后端（当前已支持 `hash-vec` / `sqlite-vec` / `ann-local`）
17. 自动召回分层预算控制（先注入 `L0`，再按预算扩到 `L1/L2`）
18. `VectorBackend` 抽象已落地，向量后端可独立替换
19. `index_jobs / index_failures` 索引队列骨架与 `memory_records` 索引状态字段已落地
20. 后台索引消费器第一版已启用，并提供 `openclaw mhm index-run` 手动 drain
21. 原生 `sqlite-vec` 第一版已接入（使用 `vec_*` 函数 + `memory_vector_blobs`，失败自动回退）
22. 已支持 `openclaw mhm index-rebuild` 批量回填旧记录的原生向量
23. `ann-local` 第一版已作为本地内存缓存后端预留（当前为缓存索引，不是最终 ANN）
24. 治理层第一版已接入：按类型自动 TTL、检索时实时过滤过期记录、`mhm policy` / `mhm cleanup`
25. 治理层自动化已接入：后台定时清理过期记录，`stats` 可见过期数量与待清理数量
26. 双阶段治理已接入：`expire` 仅逻辑失效 + 移除索引，`purge` 按保留期彻底删除主记录与插件归档文件
27. 类型落点规则已显式化：可通过 `mhm routing` 直接查看每种记忆的默认作用域、TTL 和生命周期
28. 统计视图已增强：可通过 `mhm breakdown` 查看按类型、按作用域的分布
29. 恢复能力已接入：`memory_restore` / `mhm restore` 可将 `expired` 记录恢复为 `active` 并重新入队索引
30. `idle commit` 已接入：可通过 `mhm idle-list / idle-run` 查看并触发空闲会话的自动提交，后台也会定时执行
31. 手动治理已增强：`memory_forget` / `mhm forget` 可按 `id / session / scope / type` 软删除 `active` 记录，`mhm purge` 也可按 `id / session / scope / type` 批量硬删除指定记录
32. 恢复能力已增强：`memory_restore` / `mhm restore` 现支持按 `id / session / scope / type` 批量恢复 `expired` 记录
33. 查询治理已增强：`memory_search` / `mhm search` 现支持按 `status` 查询 `active / expired / forgotten / superseded / all`
34. 读取治理已增强：新增 `memory_list` / `mhm list`，可按 `status / type / scope / session` 直接列出记录而无需搜索词
35. 导出能力已增强：新增 `memory_export` / `mhm export`，可按过滤条件导出 JSON 或 Markdown，并可选包含归档正文
36. 导入能力已增强：新增 `memory_import` / `mhm import`，可导入 `mhm export --format json` 产出的 JSON 数据并复用现有合并/索引链路
37. 导入预演已增强：`memory_import` / `mhm import --dry-run` 可预览将创建、重复和跳过的记录，不写入主库
38. 归档校验/修复已增强：新增 `memory_archive_audit` / `mhm archive-audit` 与 `memory_archive_repair` / `mhm archive-repair`
39. 孤儿归档治理已增强：新增 `memory_archive_orphan_audit` / `mhm archive-orphan-audit` 与 `memory_archive_orphan_quarantine` / `mhm archive-orphan-quarantine`
40. 隔离区治理已增强：新增 `memory_archive_quarantine_list` / `mhm archive-quarantine-list` 与 `memory_archive_quarantine_restore` / `mhm archive-quarantine-restore`
41. 隔离区清理已增强：新增 `memory_archive_quarantine_purge` / `mhm archive-quarantine-purge`
42. 统一归档巡检已增强：新增 `memory_archive_report` / `mhm archive-report`

先不做：

1. 复杂 rerank
2. 远程依赖
3. 图关系可视化
4. 自动 idle commit
5. 自动 TTL 的后台定时清理

## 9. 当前骨架文件

1. [openclaw.plugin.json](./openclaw.plugin.json)
2. [schema.sql](./schema.sql)
3. [index.js](./index.js)

## 10. 下一步建议

建议按下面顺序继续：

1. 把当前原生 `sqlite-vec` 从函数扫描升级到更高性能的本地 ANN 方案（如 `ann-local`）或更深度的向量索引形态
2. 继续增强单进程后台索引消费器的重试/告警/失败回放策略
3. 细化治理层：按类型统计、按 scope 统计、可选告警
4. 再补 idle commit 和更细的覆盖/冲突合并
5. 增加 `user/project` 记忆类型落点规则表与可视化说明

## 11. 当前待确认

当前还需要继续确认和收敛的点：

1. `projectResolver` 的默认识别是否继续用“归档目录的父目录 = 当前项目”
2. 第一版是否允许引入本地小模型做结构化提取，还是继续先纯规则
3. 归档文件是否继续沿用你现在的 `workspace/memory/*.md` 目录
