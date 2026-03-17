# 部署与启用指南

本文档只负责一件事：

1. 让你从零开始把 `memory-hybrid-context` 正确部署并启用

如果你要看完整配置，请去：

1. [CONFIG_REFERENCE.zh-CN.md](./CONFIG_REFERENCE.zh-CN.md)

如果你要跑测试，请去：

1. [TESTING.zh-CN.md](./TESTING.zh-CN.md)

## 1. 前置条件

1. OpenClaw 已可正常运行
2. 插件目录已存在：
   - `~/.openclaw/extensions/memory-hybrid-context`
3. 你准备使用本地扩展目录：
   - `~/.openclaw/extensions`
4. 如需高质量语义检索，需准备 embedding API：
   - 例如设置环境变量 `OPENAI_API_KEY`

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
      "memory": "none"
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

2. `plugins.slots.memory = "none"`
   - 禁用默认 memory slot
   - 避免双重记忆链路叠加

3. `plugins.entries.memory-hybrid-context.config.enabled = true`
   - 这是插件内部真正启用位
   - 只开外层 `enabled` 不够

## 4. 推荐启用配置

这是当前可直接使用的一套稳定配置。

说明：

1. 下面示例里的 `store.vector.backend = ann-local` 是推荐值，不是代码默认值。
2. 当前代码默认值是 `store.vector.backend = sqlite-vec`。

个人用户最小策略（不开 `agent`）：

1. 如果你是单人使用、没有多 agent 分工，建议直接使用：
   - `scopes.enabled = ["user", "project"]`
   - `scopes.primary = "user"`
   - `scopes.fallback = "project"`
   - `scopes.autoMirror = false`
   - `scopes.typeRouting.project` 里包含 `other`
2. 这样可以在“个人偏好稳定”和“项目事实可召回”之间保持平衡。

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
      "memory": "none"
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
              "extensionPath": "/home/cxd/.openclaw/workspace/.agents/vec0.so",
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
            "dir": "/home/cxd/.openclaw/workspace/.memory-hybrid"
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
            "workspacePath": "/home/cxd/.openclaw/workspace"
          }
        }
      }
    }
  }
}
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

## 7. 部署后立即做的两件事

1. 先看完整配置说明
   - [CONFIG_REFERENCE.zh-CN.md](./CONFIG_REFERENCE.zh-CN.md)

2. 立刻跑测试用例
   - [TESTING.zh-CN.md](./TESTING.zh-CN.md)

不要只看“插件已加载”就结束。真正的验收要看：

1. 写入是否成功
2. 检索是否命中
3. 前端对话是否能触发召回
