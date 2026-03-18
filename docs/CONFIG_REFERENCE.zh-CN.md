# 完整配置参考

本文档列出 `memory-hybrid-context` 在正式使用中涉及的主要配置项。

文档边界：

1. 本文档描述的是 `v0.2.0` 已实现并可直接使用的配置
2. 单网关强隔离（`agent_id`）已经落地，默认 `isolation.mode = agent`
3. 强隔离实现细节与取舍请看 [AGENT_ISOLATION_DESIGN.zh-CN.md](./AGENT_ISOLATION_DESIGN.zh-CN.md)

配置分两层：

1. OpenClaw 外层配置
2. 插件内部配置（位于 `plugins.entries.memory-hybrid-context.config`）

## 1. OpenClaw 外层配置

### `hooks.internal.entries.session-memory.enabled`

1. 层级：OpenClaw 外层
2. 类型：`boolean`
3. 推荐值：`false`
4. 是否必填：是（本插件场景）
5. 作用：关闭官方旧会话归档 hook
6. 原因：避免和当前插件重复归档
7. 风险：若保持 `true`，会继续写 `workspace/memory/*.md`

示例：
```json
"hooks": {
  "internal": {
    "enabled": true,
    "entries": {
      "session-memory": {
        "enabled": false
      }
    }
  }
}
```

### `plugins.allow`

1. 层级：OpenClaw 外层
2. 类型：`string[]`
3. 推荐值：显式包含 `memory-hybrid-context`
4. 是否必填：强烈建议
5. 作用：限定受信任插件白名单
6. 风险：为空时会出现 provenance 提示，且插件发现行为更不稳定

示例：
```json
"plugins": {
  "allow": [
    "memory-hybrid-context"
  ]
}
```

### `plugins.slots.memory`

1. 层级：OpenClaw 外层
2. 类型：`string`
3. 推荐值：`"memory-hybrid-context"`
4. 是否必填：是（本插件场景）
5. 作用：把 memory 独占 slot 指向本插件
6. 风险：若设为 `"none"`，所有 memory-kind 插件都不会加载；若设为其他 memory 插件 id，本插件不会接管

示例：
```json
"plugins": {
  "slots": {
    "memory": "memory-hybrid-context"
  }
}
```

### `plugins.entries.memory-hybrid-context.enabled`

1. 层级：OpenClaw 外层
2. 类型：`boolean`
3. 推荐值：`true`
4. 是否必填：是
5. 作用：启用该插件条目

示例：
```json
"plugins": {
  "entries": {
    "memory-hybrid-context": {
      "enabled": true
    }
  }
}
```

### `plugins.entries.memory-hybrid-context.config`

1. 层级：OpenClaw 外层
2. 类型：`object`
3. 是否必填：是
4. 作用：承载插件内部配置
5. 注意：插件的 `store`、`archive`、`capture` 等都必须放在这里

错误示例：
```json
"memory-hybrid-context": {
  "enabled": true,
  "store": {}
}
```

正确示例：
```json
"memory-hybrid-context": {
  "enabled": true,
  "config": {
    "store": {}
  }
}
```

## 2. 插件内部配置

以下字段全部位于：

1. `plugins.entries.memory-hybrid-context.config`

### `enabled`

1. 类型：`boolean`
2. 推荐值：`true`
3. 是否必填：是
4. 作用：插件内部运行时总开关
5. 注意：只开外层 `enabled` 不够，这里也要开

### `debug`

1. 类型：`boolean`
2. 推荐值：`false`
3. 是否必填：否
4. 作用：调试开关
5. 建议：仅在排障时开启

### `store.driver`

1. 类型：`string`
2. 可选值：`sqlite`
3. 推荐值：`sqlite`
4. 是否必填：是
5. 作用：主存储驱动

### `store.path`

1. 类型：`string`
2. 推荐值：`/home/cxd/.openclaw/memory-hybrid/main.sqlite`
3. 是否必填：是
4. 作用：SQLite 主库路径

### `store.vector.enabled`

1. 类型：`boolean`
2. 推荐值：`true`
3. 是否必填：建议
4. 作用：启用向量检索

### `store.vector.backend`

1. 类型：`string`
2. 可选值：
   - `hash-vec`
   - `sqlite-vec`
   - `ann-local`
   - `disabled`
3. 默认值：`sqlite-vec`
4. 推荐值：`ann-local`（中大规模场景）或 `sqlite-vec`（稳定保守场景）
5. 作用：向量后端

选择建议：

1. `ann-local`
   - 当前推荐正式方案
   - 本地 LSH，可用性和性能平衡较好

2. `sqlite-vec`
   - 适合需要原生 SQLite 向量函数能力

3. `hash-vec`
   - 适合保底或极简环境

4. `disabled`
   - 仅保留 FTS

### `store.vector.extensionPath`

1. 类型：`string`
2. 默认值：`""`
3. 推荐值：`""`（大多数场景）
4. 是否必填：仅 `sqlite-vec` 场景建议填写
5. 作用：SQLite 向量扩展路径
6. 说明：
   - 当前使用 `ann-local` / `hash-vec` 时通常不需要配置该项
   - 仅当你明确使用 `sqlite-vec` 且运行时不能自动加载扩展时，再填具体路径

### `store.vector.candidateLimit`

1. 类型：`integer`
2. 推荐值：`48`
3. 作用：向量候选上限
4. 调优方向：
   - 小：更快，但可能漏召回
   - 大：更稳，但更耗资源

### `store.vector.probePerBand`

1. 类型：`integer`
2. 推荐值：`1`
3. 作用：`ann-local` 多探针数量
4. 调优方向：
   - `0`：更保守、更窄
   - `1`：当前推荐
   - 更大：召回更宽，但候选膨胀更明显

### `store.vector.embeddingVersion`

1. 类型：`string`
2. 推荐值：`v1`
3. 作用：标记当前 embedding/向量版本
4. 用途：后续索引重建和迁移

### `store.vector.embedding.mode`

1. 类型：`string`
2. 可选值：`hash`、`openai-compatible`
3. 推荐值：
   - 低依赖环境：`hash`
   - 高质量语义检索：`openai-compatible`
4. 作用：控制向量生成方式

### `store.vector.embedding.baseURL`

1. 类型：`string`
2. 推荐值：你的 embedding 服务地址，例如 `https://api.openai.com/v1`
3. 是否必填：仅 `openai-compatible` 场景必填
4. 作用：embedding 接口基地址，插件会请求 `${baseURL}/embeddings`

### `store.vector.embedding.model`

1. 类型：`string`
2. 推荐值：例如 `text-embedding-3-small`（或你的服务支持模型）
3. 是否必填：仅 `openai-compatible` 场景必填
4. 作用：embedding 模型名称

### `store.vector.embedding.apiKey`

1. 类型：`string`
2. 推荐值：空（优先使用环境变量）
3. 是否必填：视服务要求
4. 作用：直接配置 API Key（不推荐长期明文放配置）

### `store.vector.embedding.apiKeyEnv`

1. 类型：`string`
2. 推荐值：`OPENAI_API_KEY`
3. 作用：从环境变量读取 API Key
4. 说明：当 `apiKey` 为空时，插件会读取这个环境变量

### `store.vector.embedding.dimensions`

1. 类型：`integer`
2. 推荐值：`0`
3. 作用：可选传给 embedding 接口的 `dimensions`
4. 说明：`0` 表示不显式指定维度，交给模型默认值

### `store.vector.embedding.timeoutMs`

1. 类型：`integer`
2. 推荐值：`15000`
3. 作用：embedding 请求超时（毫秒）
4. 说明：当 embedding 请求失败时，插件会回退到 `hash` 向量，保证链路可用

### `store.vector.embedding.fallbackToHash`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：当 `openai-compatible` embedding 调用失败时，是否自动回退到 `hash` 向量
4. 调优建议：
   - `true`：链路可用性优先，服务波动时仍可检索（但语义质量会降级）
   - `false`：语义质量一致性优先，embedding 不可用时不走哈希回退

### `archive.enabled`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：启用 Markdown 归档

### `archive.dir`

1. 类型：`string`
2. 默认值：`~/.openclaw/memory-hybrid/archive`
3. 推荐值：`~/.openclaw/memory-hybrid/archive`
4. 作用：归档目录
5. 注意：建议使用插件级独立目录，不要复用旧 `workspace/memory`
6. 迁移提示：如果你从旧值（`~/.openclaw/workspace/.memory-hybrid`）切换到新值，建议执行 `archive-repair` 对齐 `source_path`

### `archive.writeMarkdown`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：是否实际写归档 Markdown

### `isolation.mode`

1. 类型：`string`
2. 可选值：`agent`、`global`
3. 默认值：`agent`
4. 推荐值：`agent`
5. 作用：
   - `agent`：启用单网关强隔离。写入/检索/治理都按 `agent_id` 过滤，归档路径按 `<archive.dir>/<agentId>/...` 分桶
   - `global`：兼容模式。所有记录统一写到 `agent_id = global`，所有 agent 共享同一记忆视图；归档路径使用 `<archive.dir>/records/...`

### `isolation.defaultAgentId`

1. 类型：`string`
2. 默认值：`main`
3. 推荐值：`main`
4. 作用：当 hook 上下文或工具参数没有提供 `agentId` 时的兜底值
5. 注意：该值会参与归档路径计算（`agent` 模式）

### `capture.autoStage`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：在 `agent_end` 自动暂存候选记忆
4. 内置保护：会先清洗前端注入的 `<memory-hybrid-context> ... </memory-hybrid-context>` 召回块，以及 `Sender (untrusted metadata)` 这类前端元数据
5. 注意：明显的提问型文本（如“你还记得…吗？”）默认不会进入长期记忆，避免把用户问题本身误存成记忆

### `capture.useLlmExtraction`

1. 类型：`boolean`
2. 推荐值：`false` 或按需开启
3. 作用：是否使用 LLM 辅助提取
4. 注意：开启后依赖模型可用性

### `capture.maxCandidatesPerTurn`

1. 类型：`integer`
2. 推荐值：`3`
3. 作用：每轮最多暂存多少候选

### `capture.captureAssistant`

1. 类型：`boolean`
2. 推荐值：`false`
3. 作用：是否把 assistant 回复也纳入候选
4. 开启后行为：assistant 输出文本会像 user 文本一样进入“候选暂存”
5. 主要收益：对“助手总结出的稳定结论”沉淀更快
6. 主要风险：助手错误推断、临时措辞也可能被沉淀（自污染风险升高）
7. 建议：
   - 通用场景保持 `false`
   - 只有在助手输出结构稳定、并且有人工审查流程时再开 `true`
8. 补充：即使保持默认关闭，仍建议保留 `capture.autoStage = true`，因为当前版本已经对前端召回包和元数据做了前置清洗

### `indexing.async`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：启用异步索引

### `indexing.batchSize`

1. 类型：`integer`
2. 推荐值：`16`
3. 作用：后台索引批处理大小

### `indexing.pollMs`

1. 类型：`integer`
2. 推荐值：`3000`
3. 作用：索引队列轮询间隔

### `indexing.retryLimit`

1. 类型：`integer`
2. 推荐值：`3`
3. 作用：索引任务最大重试次数

### `commit.onNew`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：在 `/new` 时自动提交

### `commit.onReset`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：在 `/reset` 时自动提交

### `commit.idleMinutes`

1. 类型：`integer`
2. 推荐值：`20`
3. 作用：空闲多少分钟后自动提交暂存
4. `0` 表示关闭

### `recall.auto`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：启用自动召回

### `recall.maxItems`

1. 类型：`integer`
2. 推荐值：`3`
3. 作用：自动召回最多注入多少条

### `recall.maxChars`

1. 类型：`integer`
2. 推荐值：`720`
3. 作用：自动召回最大字符预算

### `recall.defaultLevel`

1. 类型：`string`
2. 可选值：`L0` / `L1` / `L2`
3. 推荐值：`L1`
4. 作用：默认分层注入级别

### 自动召回触发边界（系统命令过滤）

1. 自动召回默认只在“用户自然语言提问”场景触发
2. `/new` / `/reset` 的会话启动提示、Session Startup 系统提示不会注入 recall 包
3. 目标：避免 `<memory-hybrid-context>...</memory-hybrid-context>` 出现在系统命令响应中
4. 回归建议：如怀疑回归，请执行 [TESTING.zh-CN.md](./TESTING.zh-CN.md) 的“4.5 系统命令不触发召回测试”

### `query.hybrid`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：启用混合检索
4. 解释：
   - `true`：FTS（关键词）+ 向量（语义）融合，覆盖更稳
   - `false`：只走单路检索，策略更简单但容错能力下降

### `query.ftsWeight`

1. 类型：`number`
2. 推荐值：`0.35`
3. 作用：FTS 权重
4. 调大影响：关键词、术语、路径、ID 命中更强
5. 调小影响：语义召回占比提高，容忍表达改写

### `query.vectorWeight`

1. 类型：`number`
2. 推荐值：`0.65`
3. 作用：向量权重
4. 调大影响：语义相似优先，适合问法变化较大的召回
5. 调小影响：更依赖字面词，误召回率可能下降但漏召回可能上升
6. 建议：与 `query.ftsWeight` 联动调参，二者总和建议接近 `1`

### `query.rerank`

1. 类型：`boolean`
2. 推荐值：`false`
3. 作用：是否启用额外 rerank
4. 当前建议：默认关闭
5. 取舍：
   - `true`：通常提升 Top-N 质量，但增加延迟和计算成本
   - `false`：响应更快，链路更轻

### `scopes.enabled`

1. 类型：`string[]`
2. 推荐值：`["user", "project"]`
3. 作用：启用哪些作用域
4. 语义定义：
   - `user`：用户长期偏好、个人画像、稳定习惯
   - `project`：项目决策、实体信息、项目待办、项目事件
   - `agent`：代理执行模式、流程套路、可复用操作模式
5. 影响：
   - 启用越多，召回覆盖更广
   - 启用越少，治理更简单、噪声更低

### `scopes.primary`

1. 类型：`string`
2. 推荐值：`user`
3. 作用：默认主作用域
4. 影响：未显式指定 scope 时，优先写入/查询该作用域

### `scopes.fallback`

1. 类型：`string`
2. 推荐值：`project`
3. 作用：默认回退作用域
4. 影响：主作用域结果不足时，从回退作用域补召回

### `scopes.autoMirror`

1. 类型：`boolean`
2. 推荐值：`false`
3. 作用：是否双写到主/回退作用域
4. 建议：默认关闭，避免重复和污染

### `scopes.typeRouting`

1. 类型：`object`
2. 作用：按类型分配作用域
3. 推荐策略：
   - `profile / preference -> user`
   - `decision / event / todo / entity / case -> project`
   - `pattern -> agent`
4. 影响：
   - 路由越清晰，召回越稳定
   - 路由混乱会导致跨作用域噪声和重复沉淀
5. 标准类型集合（建议只用这些）：
   - `profile`：用户画像/身份类信息
   - `preference`：用户偏好与长期习惯
   - `decision`：明确决策与规则
   - `event`：过程事件与阶段结论
   - `todo`：待办与后续动作
   - `entity`：项目实体信息（路径、服务、环境、组件）
   - `pattern`：可复用执行方法（SOP）
   - `case`：经验案例与复盘模板
   - `other`：未分类兜底类型

### `scopes.typeRouting.user`

1. 类型：`string[]`
2. 推荐值：`["profile", "preference"]`
3. 作用：定义优先落到 `user` 作用域的记忆类型集合
4. 建议：只放跨项目长期稳定的人设/偏好类型，避免把项目事件写入 `user`

### `scopes.typeRouting.project`

1. 类型：`string[]`
2. 推荐值：`["decision", "event", "todo", "entity", "case", "other"]`
3. 作用：定义优先落到 `project` 作用域的类型集合
4. 建议：把 `other` 放在这里做兜底，减少未分类内容污染 `user`

### `scopes.typeRouting.agent`

1. 类型：`string[]`
2. 推荐值：`["pattern"]`（个人用户可设为 `[]`）
3. 作用：定义优先落到 `agent` 作用域的类型集合
4. 建议：只放执行方法模板、SOP、流程套路这类“按 agent 复用”的类型

### `scopes.enableProject`

1. 类型：`boolean`
2. 默认值：`true`
3. 作用：兼容开关；`false` 时会从已启用作用域中移除 `project`
4. 建议：新配置优先只维护 `scopes.enabled`；该字段主要用于兼容旧配置

### `scopes.enableAgent`

1. 类型：`boolean`
2. 默认值：`true`
3. 作用：兼容开关；`false` 时会从已启用作用域中移除 `agent`
4. 建议：新配置优先只维护 `scopes.enabled`；该字段主要用于兼容旧配置

`typeRouting` 如何自行决定填什么：

1. 先按“共享边界”决策：
   - 只给当前 agent 用：放 `agent`
   - 同项目多个 agent/成员需要共享：放 `project`
   - 跨项目长期复用的个人信息：放 `user`
2. 再按“记忆性质”分层：
   - 人的稳定偏好/画像优先进 `user`
   - 项目事实、待办、决策优先进 `project`
   - 执行套路与方法模板优先进 `agent`
3. 最后处理兜底：
   - 建议把 `other` 放到 `project`，避免未分类内容回流到 `user` 造成个人域污染

路由冲突与优先级：

1. 同一个类型不要同时放进多个 scope，避免行为不可预期
2. 若你仍重复配置，当前实现按 `user -> project -> agent` 顺序命中
3. 只有 `scopes.enabled` 已启用的 scope 才会真正生效

`agent` 作用域触发条件：

1. `scopes.enabled` 包含 `agent`
2. 当前记忆类型被 `typeRouting` 路由到 `agent`
3. 召回时查询 scope 包含 `agent`（主作用域或回退作用域）

`scopes.typeRouting` 推荐配置案例：

1. 案例 A：个人用户最小配置（不开 `agent`）
   - 适用：个人使用、无多 agent 分工、希望配置简单且稳定
   - 取舍：治理最简单；不保留独立 agent 方法记忆

```json
{
  "scopes": {
    "enabled": ["user", "project"],
    "primary": "user",
    "fallback": "project",
    "autoMirror": false,
    "typeRouting": {
      "user": ["profile", "preference"],
      "project": ["decision", "event", "todo", "entity", "case", "other"],
      "agent": []
    }
  }
}
```

2. 案例 B：默认平衡（个人/轻量团队）
   - 适用：大多数场景，长期偏好放 `user`，项目事实放 `project`，SOP 放 `agent`

```json
{
  "scopes": {
    "enabled": ["user", "project", "agent"],
    "primary": "user",
    "fallback": "project",
    "autoMirror": false,
    "typeRouting": {
      "user": ["profile", "preference"],
      "project": ["decision", "event", "todo", "entity", "case", "other"],
      "agent": ["pattern"]
    }
  }
}
```

3. 案例 C：多 agent 强隔离 + 项目受控共享
   - 适用：多 agent 并行，既要隔离执行记忆，也要共享项目事实
   - 取舍：隔离与共享平衡；项目共享更好，但仍需控制类型路由避免噪声

```json
{
  "scopes": {
    "enabled": ["agent", "project"],
    "primary": "agent",
    "fallback": "project",
    "autoMirror": false,
    "typeRouting": {
      "user": [],
      "project": ["decision", "event", "todo", "entity", "case", "other"],
      "agent": ["pattern", "profile", "preference"]
    }
  }
}
```

4. 案例 D：项目协作为主（多人/多仓库）
   - 适用：团队共享同一项目上下文，个人偏好次要
   - 取舍：项目沉淀快，但个人化较弱

```json
{
  "scopes": {
    "enabled": ["project", "user"],
    "primary": "project",
    "fallback": "user",
    "autoMirror": false,
    "typeRouting": {
      "user": ["profile", "preference"],
      "project": ["decision", "event", "todo", "entity", "case", "pattern", "other"],
      "agent": []
    }
  }
}
```

5. 案例 E：单库统一（最简治理）
   - 适用：想要最简单的规则和最少配置
   - 取舍：实现简单，但噪声和冲突概率较高

```json
{
  "scopes": {
    "enabled": ["project"],
    "primary": "project",
    "fallback": "project",
    "autoMirror": false,
    "typeRouting": {
      "user": [],
      "project": ["profile", "preference", "decision", "event", "todo", "entity", "case", "pattern", "other"],
      "agent": []
    }
  }
}
```

### `projectResolver.enabled`

1. 类型：`boolean`
2. 代码默认值：`true`
3. 推荐值：`true`
4. 作用：启用项目解析（将 `project` 作用域映射到稳定的 `mem://project/<projectId>`）
5. 说明：关闭后不会做项目绑定；`scopes` 仍可工作，但 `project` 作用域通常会回退到非项目粒度

### `projectResolver.mode`

1. 类型：`string`
2. 可选值：`auto` | `manual` | `workspace` | `git`
3. 代码默认值：`auto`
4. 推荐值：`manual`（更稳定、可控）
5. 作用：项目识别策略
6. 识别行为（`manual`）：仅使用 `manualKey/manualName`（或运行期 `project use` 覆盖）
7. 识别行为（`workspace`）：按工作区路径识别项目
8. 识别行为（`git`）：按 git 根目录 / origin remote 识别项目
9. 识别行为（`auto`）：按 `manual -> git -> workspace` 顺序尝试，命中第一个可用策略

### `projectResolver.workspacePath`

1. 类型：`string`
2. 推荐值：`/home/cxd/.openclaw/workspace`
3. 作用：项目解析的工作区根路径
4. 说明：留空时会回退为“当前归档目录的父目录”；为避免项目键漂移，建议显式配置

### `projectResolver.manualKey`

1. 类型：`string`
2. 作用：手动项目键（稳定主键）
3. 说明：`mode=manual` 时建议必填；若为空且无运行期覆盖，项目可能无法解析
4. 归一化：内部会标准化为 `manual:<key>` 形式

### `projectResolver.manualName`

1. 类型：`string`
2. 作用：手动项目显示名（仅展示用途）
3. 说明：不参与项目唯一性判定；唯一性由 `manualKey/projectKey` 决定

### `projectResolver` 解析优先级（运行时）

1. 若存在运行期覆盖（`openclaw mhm project use`），优先使用覆盖值
2. 若无覆盖，按 `projectResolver.mode` 检测项目上下文
3. 检测结果会写入 `project_registry`，并为项目分配/复用稳定 `projectId`（UUID）
4. `project` 作用域最终落为 `mem://project/<projectId>`
5. 运行期覆盖按 agent 维度保存（`plugin_state.active_project_key:<agentId>`），重启后保留

### `projectResolver` 运维命令

1. `openclaw mhm project current`：查看当前解析结果和覆盖值
2. `openclaw mhm project list`：查看已登记项目
3. `openclaw mhm project use <key> --name <name>`：设置手动项目覆盖
4. `openclaw mhm project bind <name>`：重命名当前项目展示名
5. `openclaw mhm project clear`：清除覆盖，回到自动解析

### `ttl.todoDays`

1. 类型：`integer`
2. 推荐值：`14`
3. 作用：`todo` 自动过期天数

### `ttl.sessionDays`

1. 类型：`integer`
2. 推荐值：`30`
3. 作用：`event / other` 自动过期天数

### `ttl.autoCleanup`

1. 类型：`boolean`
2. 推荐值：`true`
3. 作用：后台自动执行 cleanup

### `ttl.cleanupPollMs`

1. 类型：`integer`
2. 推荐值：`60000`
3. 作用：cleanup 轮询间隔

### `ttl.purgeAfterDays`

1. 类型：`integer`
2. 推荐值：`30`
3. 作用：过期记录保留多久后自动 purge

## 3. 配置案例

说明：

1. 下面案例如未显式给出 `isolation`，默认按代码默认值：`isolation.mode = agent`、`isolation.defaultAgentId = main`
2. `scopes` 是语义路由，不是执行隔离；多 agent 硬隔离由 `isolation` 控制

### 案例 A：最小可用

适合先快速跑通。

说明：本案例为极简链路，示例中使用 `hash-vec` 仅为简化部署，不代表代码默认值。

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": {
          "enabled": false
        }
      }
    }
  },
  "plugins": {
    "allow": [
      "memory-hybrid-context"
    ],
    "slots": {
      "memory": "memory-hybrid-context"
    },
    "entries": {
      "memory-hybrid-context": {
        "enabled": true,
        "config": {
          "enabled": true,
          "store": {
            "driver": "sqlite",
            "path": "/home/cxd/.openclaw/memory-hybrid/main.sqlite",
            "vector": {
              "enabled": true,
              "backend": "hash-vec"
            }
          },
          "archive": {
            "enabled": true,
            "dir": "/home/cxd/.openclaw/memory-hybrid/archive"
          },
          "recall": {
            "auto": true,
            "maxItems": 3,
            "maxChars": 720,
            "defaultLevel": "L1"
          },
          "isolation": {
            "mode": "agent",
            "defaultAgentId": "main"
          }
        }
      }
    }
  }
}
```

### 案例 B：推荐正式使用

适合当前正式使用。

说明：本案例中 `backend = ann-local` 是推荐值，不是代码默认值（默认仍是 `sqlite-vec`）。

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": {
          "enabled": false
        }
      }
    }
  },
  "plugins": {
    "allow": [
      "memory-hybrid-context"
    ],
    "slots": {
      "memory": "memory-hybrid-context"
    },
    "entries": {
      "memory-hybrid-context": {
        "enabled": true,
        "config": {
          "enabled": true,
          "store": {
            "driver": "sqlite",
            "path": "/home/cxd/.openclaw/memory-hybrid/main.sqlite",
            "vector": {
              "enabled": true,
              "backend": "ann-local",
              "candidateLimit": 48,
              "probePerBand": 1,
              "embeddingVersion": "v1",
              "embedding": {
                "mode": "openai-compatible",
                "baseURL": "https://api.openai.com/v1",
                "model": "text-embedding-3-small",
                "apiKeyEnv": "OPENAI_API_KEY",
                "timeoutMs": 15000,
                "fallbackToHash": true
              }
            }
          },
          "archive": {
            "enabled": true,
            "dir": "/home/cxd/.openclaw/memory-hybrid/archive"
          },
          "capture": {
            "autoStage": true,
            "captureAssistant": false,
            "maxCandidatesPerTurn": 3
          },
          "commit": {
            "idleMinutes": 20
          },
          "recall": {
            "auto": true,
            "maxItems": 3,
            "maxChars": 720,
            "defaultLevel": "L1"
          },
          "scopes": {
            "primary": "user",
            "fallback": "project",
            "autoMirror": false
          },
          "projectResolver": {
            "enabled": true,
            "mode": "manual",
            "workspacePath": "/home/cxd/.openclaw/workspace",
            "manualKey": "openclaw-main",
            "manualName": "OpenClaw Main"
          },
          "ttl": {
            "todoDays": 14,
            "sessionDays": 30,
            "autoCleanup": true,
            "cleanupPollMs": 60000,
            "purgeAfterDays": 30
          },
          "isolation": {
            "mode": "agent",
            "defaultAgentId": "main"
          }
        }
      }
    }
  }
}
```

### 案例 C：调试/联调

适合前端验证与功能观察。

```json
{
  "plugins": {
    "allow": [
      "memory-hybrid-context"
    ],
    "slots": {
      "memory": "memory-hybrid-context"
    },
    "entries": {
      "memory-hybrid-context": {
        "enabled": true,
        "config": {
          "enabled": true,
          "debug": true,
          "store": {
            "driver": "sqlite",
            "path": "/home/cxd/.openclaw/memory-hybrid/main.sqlite",
            "vector": {
              "enabled": true,
              "backend": "ann-local",
              "candidateLimit": 48,
              "probePerBand": 1,
              "embedding": {
                "mode": "hash"
              }
            }
          },
          "capture": {
            "autoStage": true,
            "maxCandidatesPerTurn": 3
          },
          "commit": {
            "idleMinutes": 5
          },
          "recall": {
            "auto": true,
            "maxItems": 3,
            "maxChars": 900,
            "defaultLevel": "L1"
          },
          "isolation": {
            "mode": "agent",
            "defaultAgentId": "main"
          }
        }
      }
    }
  }
}
```

### 案例 D：迁移旧方案

适合从默认记忆链路切换。

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": {
          "enabled": false
        }
      }
    }
  },
  "plugins": {
    "allow": [
      "memory-hybrid-context"
    ],
    "slots": {
      "memory": "memory-hybrid-context"
    },
    "entries": {
      "memory-hybrid-context": {
        "enabled": true,
        "config": {
          "enabled": true,
          "store": {
            "driver": "sqlite",
            "path": "/home/cxd/.openclaw/memory-hybrid/main.sqlite",
            "vector": {
              "enabled": true,
              "backend": "ann-local",
              "embedding": {
                "mode": "hash"
              }
            }
          },
          "archive": {
            "enabled": true,
            "dir": "/home/cxd/.openclaw/memory-hybrid/archive"
          },
          "recall": {
            "auto": true,
            "maxItems": 3,
            "maxChars": 720,
            "defaultLevel": "L1"
          },
          "isolation": {
            "mode": "agent",
            "defaultAgentId": "main"
          }
        }
      }
    }
  }
}
```
