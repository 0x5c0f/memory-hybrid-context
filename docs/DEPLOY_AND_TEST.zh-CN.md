# 部署与启用指南

本文档只负责一件事：

1. 让你从零开始把 `memory-hybrid-context` 正确部署并启用

如果你要看完整配置，请去：

1. [CONFIG_REFERENCE.zh-CN.md](./CONFIG_REFERENCE.zh-CN.md)

如果你要跑测试，请去：

1. [TESTING.zh-CN.md](./TESTING.zh-CN.md)

说明：

1. 本文档是 `v0.2.0` 现网可执行部署步骤
2. 单网关强隔离（`agent_id`）已实现，默认 `isolation.mode = agent`

## 1. 前置条件

1. OpenClaw 已可正常运行
2. 插件目录已存在：
   - `~/.openclaw/extensions/memory-hybrid-context`
3. 你准备使用本地扩展目录：
   - `~/.openclaw/extensions`
4. 如需高质量语义检索，需准备 embedding API：
   - 例如设置环境变量 `OPENAI_API_KEY`

### 1.1 首次部署模式（推荐）

如果你当前按“首次部署插件”执行（推荐）：

1. 插件主库视为全新空库
2. 历史记忆只在 `workspace` 文件里
3. 通过迁移命令一次性导入到默认作用域

这个模式下，不存在“旧库混合数据归属不清”的问题，部署风险最低。

## 2. 安装方式

### 方式 A：直接使用源码目录

如果你当前已经在本机开发或调试：

1. 确认目录存在：
```bash
rg --files ~/.openclaw/extensions/memory-hybrid-context | sed -n '1,50p'
```

### 方式 B：使用整包归档

如果你在新环境部署，建议用正式包：

1. 整包：
   - `~/.openclaw/extensions/memory-hybrid-context-latest.bundle.tar.gz`
   - 这是固定名称的最新正式包
   - 如果需要回滚到历史版本，请改用 `../releases/<version>/` 下的时间戳快照

2. 解压：
```bash
mkdir -p ~/.openclaw/extensions
tar -xzf ~/.openclaw/extensions/memory-hybrid-context-latest.bundle.tar.gz -C ~/.openclaw/extensions
```

3. 解压后应得到：
   - `~/.openclaw/extensions/memory-hybrid-context`

4. 如需了解发布策略：
   - [RELEASE_STRATEGY.zh-CN.md](./RELEASE_STRATEGY.zh-CN.md)

## 3. 必须修改的 OpenClaw 配置

这是启用本插件的最小必要外层配置。

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
          "enabled": true
        }
      }
    }
  }
}
```

### 这里为什么必须这样配

1. `session-memory = false`
   - 关闭官方旧归档 hook
   - 否则会继续往旧路径写文件，和当前插件冲突

2. `plugins.slots.memory = "memory-hybrid-context"`
   - 让本插件接管 memory 独占 slot
   - 避免与 `memory-core` / `memory-lancedb` 双重链路叠加
   - 如果仍为 `"none"`，本插件会因 memory slot 未选中而不加载

3. `plugins.entries.memory-hybrid-context.config.enabled = true`
   - 这是插件内部真正启用位
   - 只开外层 `enabled` 不够

## 4. 推荐启用配置

这是当前可直接使用的一套稳定配置。

说明：

1. 下面示例里的 `store.vector.backend = ann-local` 是推荐值，不是代码默认值。
2. 当前代码默认值是 `store.vector.backend = sqlite-vec`。
3. `scopes` 是语义分层，不是执行隔离；多 agent 隔离由 `isolation` 决定。

个人用户最小策略（不开 `agent`）：

1. 这里的“不开 `agent`”指的是 `scopes.enabled` 不启用 `agent` 语义层，不是关闭隔离。
2. 如果你是单人使用、没有多 agent 分工，建议直接使用：
   - `scopes.enabled = ["user", "project"]`
   - `scopes.primary = "user"`
   - `scopes.fallback = "project"`
   - `scopes.autoMirror = false`
   - `scopes.typeRouting.project` 里包含 `other`
3. 这样可以在“个人偏好稳定”和“项目事实可召回”之间保持平衡。

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
            "enabled": ["user", "project"],
            "primary": "user",
            "fallback": "project",
            "autoMirror": false,
            "typeRouting": {
              "user": ["profile", "preference"],
              "project": ["decision", "event", "todo", "entity", "case", "other"],
              "agent": []
            }
          },
          "projectResolver": {
            "enabled": true,
            "mode": "manual",
            "workspacePath": "/home/cxd/.openclaw/workspace",
            "manualKey": "openclaw-main",
            "manualName": "OpenClaw Main"
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

`projectResolver` 补充说明：

1. 若使用 `mode = "manual"`，建议同时配置 `manualKey`；否则项目可能无法解析（除非你再执行 `openclaw mhm project use <key>`）
2. 若使用 `mode = "auto"`，可不填 `manualKey`，让插件按 `manual -> git -> workspace` 顺序自动识别
3. `workspacePath` 建议显式配置，避免回退到归档目录父路径导致项目键不符合预期

如果你是从旧配置升级（旧值是 `/home/cxd/.openclaw/workspace/.memory-hybrid`）：

1. 先切到新 `archive.dir`
2. 再执行一次归档修复，更新库内 `source_path` 到新目录
```bash
openclaw mhm archive-repair --status all --limit 500
```

## 5. 启用步骤

1. 如使用 `apiKeyEnv`，先注入环境变量（示例）：
```bash
export OPENAI_API_KEY="<your-key>"
```

2. 写好配置
3. 重启 Gateway
```bash
openclaw gateway restart
```

4. 确认插件已加载
```bash
openclaw plugins doctor
openclaw plugins info memory-hybrid-context --json
```

## 6. 启用成功的判断标准

看到下面这些现象，说明部署成功：

1. `plugins info` 返回：
   - `status = loaded`
   - `enabled = true`

2. 有 CLI：
   - `cliCommands = ["mhm"]`

3. 有 hook：
   - `hookCount > 0`

4. 有 service：
   - `services` 中包含 `memory-hybrid-context`

5. 基础命令可执行：
```bash
openclaw mhm stats
```

6. 若启用语义 embedding，`mhm stats` 中应看到：
   - `vector.embeddingMode = "openai-compatible"`
   - `vector.embeddingModel` 为你配置的模型名

## 7. 强隔离快速验证（`isolation.mode = agent`）

1. 用两个 agent 写入不同测试数据：
```bash
openclaw mhm --agent-id agent-a commit "隔离测试：这是 A 侧记录" --type event --session iso-a
openclaw mhm --agent-id agent-b commit "隔离测试：这是 B 侧记录" --type event --session iso-b
```

2. 交叉检索：
```bash
openclaw mhm --agent-id agent-a search "这是 A 侧记录" --status all --limit 5
openclaw mhm --agent-id agent-b search "这是 A 侧记录" --status all --limit 5
```

通过标准：

1. `agent-a` 能检索到 A 记录
2. `agent-b` 默认检索不到 A 记录

## 8. 部署后立即做的两件事

1. 先看完整配置说明
   - [CONFIG_REFERENCE.zh-CN.md](./CONFIG_REFERENCE.zh-CN.md)

2. 立刻跑测试用例
   - [TESTING.zh-CN.md](./TESTING.zh-CN.md)

不要只看“插件已加载”就结束。真正的验收要看：

1. 写入是否成功
2. 检索是否命中
3. 前端对话是否能触发召回
