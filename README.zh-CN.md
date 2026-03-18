# memory-hybrid-context

`memory-hybrid-context` 是一个面向 OpenClaw 的分层双轨长期记忆插件。

它的目标不是单纯“多一个记忆库”，而是同时解决下面几件事：

1. 自动沉淀长期记忆，减少重复输入
2. 通过分层记忆减少上下文冗余
3. 提供可治理、可审计、可修复的记忆系统
4. 在本地优先的前提下支持中等规模扩展

## 适用场景

适合下面这类使用方式：

1. 同一用户会反复进行多轮、多天、多会话协作
2. 希望记住用户偏好、项目决策、实体信息、近期事件
3. 希望可以用命令直接查、列、导出、修复记忆
4. 希望从默认记忆方案迁移到一套更可控的插件

不适合把它当成：

1. 纯云端托管的黑盒记忆服务
2. 零治理、零维护的“一劳永逸”组件

## 你会得到什么

启用后，这个插件提供：

1. 自动暂存
   - 对话结束时捕获候选记忆

2. 自动提交
   - `/new`
   - `/reset`
   - 空闲超时 `idle commit`

3. 自动召回
   - 在新一轮对话开始前按需召回

4. 分层记忆
   - `L0`：短标题
   - `L1`：摘要
   - `L2`：完整说明

5. 双轨存储
   - SQLite 结构化主库
   - Markdown 归档文件

6. 检索与索引
   - FTS
   - 向量检索
   - 混合检索
   - 异步索引队列
   - 可选 `openai-compatible` embedding（用于高质量语义检索）

7. 治理能力
   - TTL
   - `cleanup`
   - `purge`
   - `restore`
   - `forget`

8. 运维能力
   - `stats`
   - `policy`
   - `routing`
   - `breakdown`
   - `archive-report`
   - `consistency-report`
   - `consistency-repair`

## 主要优点

1. 本地优先
   - 不依赖外部记忆 SaaS

2. 可审计
   - 有归档文件、有一致性审计、有修复命令

3. 可治理
   - 不是“写进去就再也管不了”的记忆实现

4. 可扩展
   - 已经支持可插拔向量后端
   - 代码默认后端是 `sqlite-vec`，也可按场景切换到 `ann-local` / `hash-vec`

5. 可迁移
   - 支持导出、导入、导入预演

## 当前限制

1. `ann-local` 已可用，但仍是本地 LSH 方案，不是最终极 ANN 实现
2. 默认 `embedding.mode = hash`（注意这不等于 `backend = hash-vec`）；语义质量要求高时建议配置 `store.vector.embedding.mode = openai-compatible`
3. `openai-compatible` 模式默认 `fallbackToHash = true`，可用性更高；如果你要求严格语义一致性，可改为 `false`
4. 需要正确关闭冲突项，否则会和旧链路重复工作
5. 需要你的模型提供方可正常工作，否则对话本身失败会影响你观察记忆效果
6. 如果是“中途启用插件”，旧 `workspace/memory/*.md` 不会自动回灌，需要执行迁移脚本（见 `docs/OPERATIONS.zh-CN.md`）

## 部署前必须知道的冲突项

这是最关键的一节，很多部署问题都出在这里。

### 必须配置

1. `plugins.entries.memory-hybrid-context.enabled = true`
2. `plugins.entries.memory-hybrid-context.config.enabled = true`
3. `plugins.slots.memory = "memory-hybrid-context"`
   - 将 memory 独占 slot 指向本插件
   - 避免与 `memory-core` / `memory-lancedb` 并行接管

4. `hooks.internal.entries.session-memory.enabled = false`
   - 必须关闭官方旧会话归档 hook
   - 否则会继续往 `workspace/memory/*.md` 写旧归档
   - 会导致重复归档、旧路径噪音和测试干扰

### 强烈建议

1. `plugins.allow` 显式包含 `memory-hybrid-context`
2. 保持 `plugins.allow` 为最小必要白名单
   - 白名单里只保留当前明确要启用的插件，减少无关告警和干扰

## 配置结构

`memory-hybrid-context` 的配置分成两层：

1. OpenClaw 外层配置
2. 插件内部配置

正确结构示例：

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
          "enabled": true
        }
      }
    }
  },
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
}
```

注意：

1. 插件配置项必须放在 `plugins.entries.memory-hybrid-context.config` 下
2. 不能把 `store`、`archive`、`capture` 等字段直接平铺在 `plugins.entries.memory-hybrid-context` 下

## 推荐阅读顺序

如果你是第一次接触这个插件，建议按这个顺序读：

1. [DEPLOY_AND_TEST.zh-CN.md](./docs/DEPLOY_AND_TEST.zh-CN.md)
   - 先完成安装和启用

2. [CONFIG_REFERENCE.zh-CN.md](./docs/CONFIG_REFERENCE.zh-CN.md)
   - 逐项理解所有配置

3. [CONFIG_ALL_OPTIONS.zh-CN.json5](./docs/CONFIG_ALL_OPTIONS.zh-CN.json5)
   - 人类可读的全量配置模板（JSON5 行级注释，字段取值是推荐基线，注释同时标注真实默认值）

4. [TESTING.zh-CN.md](./docs/TESTING.zh-CN.md)
   - 跑完整测试，尤其是前端对话召回测试

5. [OPERATIONS.zh-CN.md](./docs/OPERATIONS.zh-CN.md)
   - 后续运维、排障、巡检

6. [RELEASE_STRATEGY.zh-CN.md](./docs/RELEASE_STRATEGY.zh-CN.md)
   - 查看正式发布、快照归档和 `latest` 包策略

7. [RELEASE_CHECKLIST.zh-CN.md](./docs/RELEASE_CHECKLIST.zh-CN.md)
   - 每次变更后快速验收

8. [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)
   - 看版本演进

## 当前基线归档

当前环境基线已归档，可作为正式比对基线：

1. [BASELINE_2026-03-03.zh-CN.md](./docs/baselines/2026-03-03/BASELINE_2026-03-03.zh-CN.md)
2. [consistency-report.json](./docs/baselines/2026-03-03/consistency-report.json)
3. [consistency-report.md](./docs/baselines/2026-03-03/consistency-report.md)
4. [archive-report.json](./docs/baselines/2026-03-03/archive-report.json)
5. [archive-report.md](./docs/baselines/2026-03-03/archive-report.md)

## 一句话部署路径

如果你只想先把它跑起来：

1. 按 [DEPLOY_AND_TEST.zh-CN.md](./docs/DEPLOY_AND_TEST.zh-CN.md) 配置
2. 确保关闭 `session-memory`
3. 重启 Gateway
4. 跑 [TESTING.zh-CN.md](./docs/TESTING.zh-CN.md) 里的前端召回测试
