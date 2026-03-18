# 单网关强隔离实现说明（Agent Isolation）

状态：

1. 本文档描述的是 `v0.2.0` 已实现能力
2. 默认隔离模式：`isolation.mode = agent`
3. 兼容回退模式：`isolation.mode = global`

## 1. 为什么要做强隔离

在单网关多 agent 场景里，只靠 `scope`（`user/project/agent`）做语义分层不够。

需要补一条硬边界：

1. `scope`：语义路由维度（记忆属于哪一层）
2. `agent_id`：租户隔离维度（记忆属于哪个执行 agent）

两者正交，缺一不可。

## 2. 当前落地架构

采用“单库 + `agent_id` 分区 + agent 子目录归档”模型。

### 2.1 主库

核心表已增加 `agent_id`：

1. `memory_records`
2. `staging_candidates`
3. `commit_log`
4. `recall_events`
5. `index_jobs`
6. `index_failures`

并补充了 agent 维度索引，保证检索与治理性能。

### 2.2 归档

`archive.dir` 作为总根目录，按 agent 分桶：

1. `<archive.dir>/<agentId>/records/*.md`
2. `<archive.dir>/<agentId>/sessions/*.md`
3. `<archive.dir>/<agentId>/quarantine/*.md`

### 2.3 运行时上下文

`agentId` 的来源优先级：

1. 工具参数显式传入（如 `openclaw mhm --agent-id agent-a ...`）
2. hook 上下文（`before_agent_start/agent_end/before_reset`）
3. `isolation.defaultAgentId`（兜底，默认 `main`）

## 3. 配置开关

位于 `plugins.entries.memory-hybrid-context.config`：

```json
{
  "isolation": {
    "mode": "agent",
    "defaultAgentId": "main"
  }
}
```

字段说明：

1. `mode`
   - `agent`：强隔离，写入/检索/治理都按 `agent_id`
   - `global`：兼容模式，统一 `agent_id = global`，归档路径回到 `<archive.dir>/records/...`
2. `defaultAgentId`
   - 当前链路拿不到 `agentId` 时的兜底值

## 4. 和 scopes 的关系

`scope` 不是隔离边界，`agent_id` 才是。

1. `scope` 继续负责类型路由（`user/project/agent`）
2. `agent_id` 决定记录可见性边界
3. 因此“同一 scope 下不同 agent”仍然隔离

## 5. 首次部署迁移建议

推荐采用“首次部署”路径：

1. 新插件库视为全新空库
2. 旧记忆只在 `workspace` 文件
3. 用迁移命令一次性导入到默认 agent（通常 `main`）

这个路径可以规避“历史混合库无法精确归属 agent”的风险。

## 6. 验收标准

至少满足以下检查：

1. Agent A 写入记录，Agent B 默认不可检索
2. 归档文件落在对应的 `<archive.dir>/<agentId>/...` 路径
3. `mhm stats`、`archive-report`、`consistency-report` 可按 `agentId` 查看
4. 切换到 `isolation.mode = global` 后可回退到共享视图

可直接执行：

```bash
openclaw mhm --agent-id agent-a commit "隔离测试：这是 A 侧记录" --type event --session iso-a
openclaw mhm --agent-id agent-b commit "隔离测试：这是 B 侧记录" --type event --session iso-b
openclaw mhm --agent-id agent-a search "这是 A 侧记录" --status all --limit 5
openclaw mhm --agent-id agent-b search "这是 A 侧记录" --status all --limit 5
```

## 7. 兼容性说明

1. 默认 `agent` 模式适合多 agent 强隔离
2. `global` 模式用于兼容旧行为或过渡期
3. 不建议在生产中把隔离模式频繁切换，避免观察口径混乱
