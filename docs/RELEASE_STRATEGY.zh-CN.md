# 发布策略

本文档定义 `memory-hybrid-context` 的统一发布与归档策略。

目标：

1. 保留每次发布的不可变快照，避免后续打包覆盖历史版本
2. 同时保留一个固定的 `latest` 正式包，便于日常部署
3. 让发布物可追溯、可校验、可回滚

## 1. 产物类型

发布产物分为两类：

1. 不可变快照
2. `latest` 正式包

### 1.1 不可变快照

每次打包都会生成一个带时间戳的快照文件，文件名不会复用。

路径格式：

1. `~/.openclaw/extensions/memory-hybrid-context/releases/<version>/memory-hybrid-context-<version>-<timestamp>.bundle.tar.gz`

配套文件：

1. `*.sha256`
2. `*.manifest.json`

说明：

1. 快照用于归档、回滚、审计
2. 任何一次新的发布都不应覆盖旧快照

### 1.2 latest 正式包

每次打包后，同时刷新一个固定名称的最新包：

1. `~/.openclaw/extensions/memory-hybrid-context-latest.bundle.tar.gz`

配套文件：

1. `~/.openclaw/extensions/memory-hybrid-context-latest.bundle.tar.gz.sha256`
2. `~/.openclaw/extensions/memory-hybrid-context-latest.json`

说明：

1. `latest` 用于日常部署
2. 它允许被更新
3. 它始终指向最近一次成功生成的正式包

## 2. 当前推荐使用方式

### 日常部署

优先使用 `latest`：

```bash
tar -xzf ~/.openclaw/extensions/memory-hybrid-context-latest.bundle.tar.gz -C ~/.openclaw/extensions
```

### 回滚或对比

从对应版本目录下选择快照：

1. `~/.openclaw/extensions/memory-hybrid-context/releases/<version>/`

## 3. 打包命令

使用插件自带脚本：

```bash
cd ~/.openclaw/extensions/memory-hybrid-context
bash scripts/release-package.sh
```

也可以显式指定时间戳：

```bash
bash scripts/release-package.sh 20260303-183000
```

## 4. 打包后会发生什么

脚本会：

1. 在 `releases/<version>/` 下生成一份不可变快照
2. 生成对应的 `sha256` 校验文件
3. 生成对应的 `manifest.json`
4. 刷新 `~/.openclaw/extensions/memory-hybrid-context-latest.bundle.tar.gz`
5. 刷新 `latest` 的校验文件和元信息文件

## 5. 注意事项

1. `latest` 是可变的
   - 它用于部署便利，不用于长期审计

2. 真正的历史归档应以 `releases/<version>/` 下的时间戳快照为准

3. 打包时会排除插件目录内部的 `releases/`
   - 避免把旧归档再次打进新包里

## 6. 推荐流程

每次准备发布时：

1. 先跑 [RELEASE_CHECKLIST.zh-CN.md](./RELEASE_CHECKLIST.zh-CN.md)
2. 再执行 `bash scripts/release-package.sh`
3. 使用 `latest` 做日常部署
4. 使用 `releases/<version>/` 下的快照做归档与回滚
