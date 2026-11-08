# Virtuoso Bridge — DSH 插件指南

[English](plugin-guide.md) | **简体中文** · [README](../README.zh-CN.md)

本指南介绍 `dsh-virtuoso-bridge` 插件的安装、DSH 界面、运行时行为、智能体工具、
故障排查和开发方式。

## 1. 插件定位

插件为 [virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite)
提供 DeepSeek Harness（DSH）封装，管理：

- 安装 virtuoso-bridge-lite 的隔离 Python venv；
- SSH 连接和主机密钥信任；
- 跨会话存活的 SSH 隧道和 CIW 守护进程；
- 固定端口旧版守护进程，以及自动会话/实例发现；
- 批量 Python 任务和对全部 Python API 的直接访问；
- 左侧配置页和右侧运行时面板。

插件是标准 DSH bundle，分为 Host（`index.js`、`lib/`）和 Client（`client.js`）两半。
每个运行时由 `runtime/vb_sidecar.py` 持有真正的 virtuoso-bridge 客户端。插件不实现
自己的 Maestro runner、job store、dialog manager、history manager 或调度器；
这些能力使用上游 VBL/DSH 设施。

## 2. 环境要求

- DSH 0.2.2 系列、Cordis 4.x；
- DSH 提供的 Node.js 运行时；
- Python 3（用于插件 venv）；
- 首次安装需要访问 Python 包索引；
- 建议 `PATH` 中有 OpenSSH；没有时安装会要求确认并改用 Paramiko；
- 实际 SKILL 操作需要可访问的 SSH 主机和运行中的 Virtuoso CIW。

## 3. 安装

插件以公开 scoped 包 **`@nekomona/dsh-virtuoso-bridge`** 发布。

### 从 npm 安装（推荐）

让智能体安装该 bundle，或使用插件管理器的 `install_bundle` 指定包名：

> Install the DSH bundle `@nekomona/dsh-virtuoso-bridge`.

不需要 submodule，也不需要 Python checkout。发布包内含插件所装
`virtuoso-bridge-lite/` 的打包子集（`pyproject.toml`、`README.md`、`AGENTS.md`、
`LICENSE`、`mcp_server.py`、`src/**`、`skills/**`）以及
`virtuoso-bridge-lite.pin.json`，插件只需创建 venv 并从该源码安装。

### 从 git checkout 安装（开发）

```powershell
git clone --recurse-submodules https://github.com/nekomona/dsh-virtuoso-bridge.git <plugin-directory>
```

`virtuoso-bridge-lite/` 是固定到上游 virtuoso-bridge-lite 的 git submodule。如果
clone 时没有加 `--recurse-submodules`，安装前先初始化：

```powershell
git submodule update --init virtuoso-bridge-lite
```

通过 DSH 插件管理器安装该目录，或让智能体执行：

> Install the plugin bundle at `<plugin-directory>`.

安装后刷新一次 DSH 页面以加载最新浏览器 bundle。

数据目录：

```text
%USERPROFILE%\.dsh\virtuoso-bridge\<profile>\
```

`<profile>` 默认是 `default`，可由 `$DSH_PROFILE`、`config.dataDir` 或
`VB_PLUGIN_DATA_DIR` 覆盖。

## 4. 首次配置

从左侧全局面板列表打开 **Virtuoso Bridge 配置**。页面默认显示
**服务器连接**；环境、默认设置、存储和活动默认折叠。

### 4.1 环境

环境卡提供：

- 未安装时的 **安装**；
- 已安装时的 **诊断**；
- `⋯` 菜单中的 **修复**、**更新**；
- 折叠的 **来源与安装日志**，包含：
  - 来源模式（内置源码 / 本地仓库 / git）；
  - Python 可执行文件；
  - 本地路径或 git URL/ref；
  - 内置来源的 `virtuoso-bridge-lite.pin.json` 固定信息（上游提交、日期、许可）；
  - 安装日志；
  - 后端和文档详情。

来源和 `pythonPath` 一起保存；安装/更新前会先保存当前可见的来源草稿，确保实际使用
用户选择的来源。

### 4.2 来源模式

- **内置源码**：默认，从插件固定的 `virtuoso-bridge-lite/` git submodule 安装
  （`1f186abfbb3d658211743cd707f3156ed2f59a87`，记录在
  `virtuoso-bridge-lite.pin.json`）。固定的是精确提交，`.gitmodules` 不声明 `branch`，
  因此上游 `main` 更新不会改变内置源码；不要执行 `git submodule update --remote`。
  不需要访问工具仓库；pip 仍需包索引。源码安装必须已初始化 submodule：
  `virtuoso-bridge-lite/` 缺失或未初始化时，安装会报错并给出
  `git submodule update --init virtuoso-bridge-lite`（以及固定提交）的提示。npm 用户
  不会遇到该状态，因为发布包内含 `virtuoso-bridge-lite/` 的打包子集。
- **本地开发仓库**：从 `source.localRepoPath` 以 editable 方式安装，代码修改在下次
  运行时启动时生效。
- **Git 仓库**：按 `source.repoUrl` / `source.gitRef` 克隆到 profile 数据目录。

### 4.3 连接

连接卡直接显示：

- 状态和名称；
- **启动/停止**；
- **编辑**；
- **测试**；
- **部署守护进程设置**；
- `⋯`：DSH 自动连接、发现实例、删除。

连接编辑器只显示主要字段，高级网络、主机角色、shell/Cadence 环境、凭据和
工作目录子实例位于折叠区域。点击编辑会自动滚动到编辑器。

高级字段包括 jump host、SSH backend、SSH proxy、identity file、角色覆盖
（`daemonHost`、`deployHost`、`guiHost`、`spectreHost`）、远程暂存根目录、
client id、备注和子实例。

### 4.4 凭据

守护进程 token 写入 DSH credentials 服务，不保存在连接 JSON 或日志中。
token 输入框只写；界面只显示是否已保存，并支持清除。

## 5. 守护进程部署

**部署守护进程设置** 只准备/上传生成的 account bootstrap，不启动隧道、不启动/连接
守护进程，也不加载 SKILL。成功后，在目标空闲 CIW 中执行：

```skill
load("/path/to/virtuoso_setup.il")
```

### 固定端口模式

连接选择远程端口（或由 SSH 用户名派生）。CIW setup 在该端点启动守护进程。

### 自动会话

启用 `autoSessions` 或使用工作目录子实例。插件发现已注册守护进程，并按端口/工作目录
选择。每个子实例拥有独立的 VBL profile/sidecar，并在右侧显示为独立运行时卡。

### 冲突处理

如果远端生成 bundle 与当前 bundle 不同，普通部署不会覆盖。面板显示：

- 新/当前包版本（已知时）；
- 现有守护进程版本（已知时），否则显示“版本未知”；
- 后端冲突详情。

只有用户明确点击红色 **覆盖** 按钮才允许替换，旧 bundle 会保留。
通过 `daemonSetup` / install-daemon 管理的共享 setup 对客户端只读。

覆盖后需在 CIW 中加载新返回的 setup 行。

## 6. 运行时生命周期

| 状态 | 含义 |
| --- | --- |
| `stopped` | 无管理运行时 |
| `starting` | 隧道/sidecar 启动中 |
| `connecting` | sidecar 连接/部署中 |
| `waiting` | 隧道已建立，守护进程未响应 |
| `running` | 守护进程正常响应 |
| `error` | 启动/健康检查/运行时失败 |
| `needs-trust` | 未知 SSH 主机密钥等待确认 |

运行时面板显示连接状态、守护进程/健康摘要、远程项目工作目录和错误详情。
Host 每 20 秒检查一次状态；守护进程不响应时会检查 X11 对话框。

### 弹窗阻塞

当 CIW 被模态弹窗阻塞：

- 状态会包含弹窗标题；
- 面板显示警告；
- 提示用户点击/回答 Virtuoso 中的弹窗后刷新；
- 不会误提示重装或重新部署守护进程。

如果守护进程之前正常、随后停止响应，面板会显示守护进程丢失原因，而不是首次安装
提示。

## 7. 右侧运行时面板

右侧标签固定为 **Virtuoso Bridge**；标签太窄时由 DSH 自动裁剪/隐藏文字。

内容：

- **环境**：仅在环境未就绪时显示，并提供 **打开设置**。
- **服务器连接**：所有连接，包含启动/停止、状态和详情折叠。
- **智能体活动**：当前会话的智能体置顶并高亮。每个智能体独立展开/折叠历史；
  运行中的工具始终可见。
- **连接 pill**：与 **最近使用** 同一行显示该智能体使用过的服务器。
  不活跃超过 10 分钟变灰；超过 30 分钟从 pill 中移除，但智能体行保留。
- **存储**：一行显示缓存大小/剩余空间；完整路径、大小和清理按钮在配置页。

双击智能体行会在主视图打开对应 DSH 会话；单击展开/折叠历史。

### Composer 按钮

输入框左侧的 VB 图标带状态点：

- 绿色：已连接；
- 黄色：等待/阻塞；
- 红色：错误；
- 呼吸绿色：该会话正在执行工具。

不显示额外文字；会话没有活动运行时不显示按钮。

## 8. 智能体工具

### `virtuoso_bridge_runtime`

常用动作：

- `status`、`list`
- `start`、`stop`、`restart`
- `ping`
- `deploy_daemon`
- `instances`、`select_instance`
- `detect_shell`
- `host_key`、`trust_host`
- `save_connection`、`delete_connection`、`connections`

示例：

```text
virtuoso_bridge_runtime action=status
virtuoso_bridge_runtime action=start connection=lab
virtuoso_bridge_runtime action=deploy_daemon connection=lab
virtuoso_bridge_runtime action=select_instance connection=lab port=65123
```

`status` 只显示活跃/近期智能体，并报告项目 cwd、守护进程状态、弹窗状态、
首次就绪前的 setup 提示和错误。

### `virtuoso_bridge_api`

描述或调用任意公开 VBL 目标：

```text
virtuoso_bridge_api action=describe target=client
virtuoso_bridge_api action=describe target=client.schematic
virtuoso_bridge_api action=call target=client.schematic method=open_window ...
```

目标包括 `client`、`client.schematic`、`client.layout`、`client.library`、
`client.symbol`、`client.maestro`、`client.sos`、`client.dialogs`、
`client.requests` 和 `spectre`。

### `virtuoso_bridge_script`

在插件 venv 中运行 Python，可直接使用已连接客户端：

```python
result = {"windows": client.schematic.list_windows()}
```

行为：

- `run` 创建 action/job；未完成时返回 `Running` 和 job id；
- `status` 返回完整 job 快照；
- `list` 列出近期 job；
- `cancel` 取消任务；
- 必须提供一行 `description`，用于工具卡和历史；
- Chat 工具卡显示 `Script: <description>`、代码和结果，并且始终可展开。

### `virtuoso_bridge_setup`

- `status`、`preflight`
- `install`、`update`
- `diagnose`
- `configure`、`set_source`
- `caches`、`clear_cache`

## 9. 活动、存储和诊断

- 配置页的 **活动** 默认折叠，包含操作和日志。
- 配置页的 **存储** 包含缓存名称、路径、字节数、文件数、剩余空间和逐项清理按钮。
- 右侧面板只保留一行存储摘要。
- 运行时诊断包含阶段、SSH 后端、主机密钥探测、隧道/守护进程状态、错误详情和弹窗
  检查结果。

## 10. 安全

- 主机密钥必须显式信任；变更密钥视为冲突，不会被静默替换。
- 守护进程 token 由 DSH credentials 保存，通过 sidecar 环境传入。
- Dashboard 通过仅回环可读的端点引导每进程 token。
- 远程 setup 路径由 VBL 进行私有目录和所有权校验。
- 共享/install-daemon setup 不能被客户端替换。

## 11. 故障排查

### 守护进程无响应

1. 检查 CIW 是否被模态弹窗阻塞；面板/状态会报告标题，点击/回答弹窗。
2. 如果 setup 从未加载，执行打印的 `load("...")`。
3. 如果守护进程之前正常，检查 CIW 是否被长命令占用、会话崩溃或端口变化。
4. 不要直接重装；面板会显示实际健康原因。

### 部署冲突

1. 阅读冲突卡，比较显示的版本。
2. 只有在现有生成 bundle 过期/损坏或 profile 变化时才点击 **覆盖**。
3. 覆盖后在目标 CIW 加载新的 setup 行。

### DSH 中出现 `Failed to fetch`

客户端会清理过期 dashboard base/token 后重试一次，带请求超时，并优先使用当前页面
origin。如果 dashboard 服务重启，刷新 DSH 页面。

### 历史一直显示加载中

历史内容在展开时获取；本地超时会清除加载状态，成功时显示代码/结果。后端不可达时
会显示错误而不是无限等待。

### SSH / OpenSSH 问题

- 确认 `ssh` 在 `PATH` 中，或显式选择 Paramiko；
- 检查连接编辑器中的 jump host、端口和角色字段；
- 主机密钥冲突必须由用户显式信任。

## 12. 开发

```powershell
node --check index.js
node --check client.js
node --check lib/manager.js
node --check lib/tools.js
node --test tests/*.test.mjs
python -m py_compile runtime/vb_sidecar.py
node --check runtime/vb_deploy.py
node scripts/prepare-vendor.mjs --verify-only
node scripts/check-no-private-data.mjs
node scripts/check-branch-privacy.mjs --worktree
node --test tests/*.test.mjs
npm pack --dry-run
```

`prepare-vendor.mjs --verify-only` 校验 `virtuoso-bridge-lite/` gitlink 是否与
`virtuoso-bridge-lite.pin.json` 一致，且 `.gitmodules` 未配置 branch（发布工作流执行
同一检查；完整脚本作为 `prepack` 自动运行）；`check-no-private-data.mjs` 是面向
token、本机路径和备份目录的公开发布检查；`check-branch-privacy.mjs` 还会扫描本分支
新增的提交信息与 diff，拒绝服务器名、账号名和用户主目录（git 的作者/提交者身份
除外）；`--worktree` 同时检查未提交改动，CI 提供 base SHA 与可选的
`VB_PRIVATE_NAMES` 仓库变量。`npm pack --dry-run` 只列出发布包内容，不执行发布。

客户端修改后刷新 DSH 页面；Host 修改需重新加载插件。插件原则是封装现有
VBL/DSH API，而不是增加并行基础设施。

## 13. 限制

- 插件不能自动向运行中的 CIW 加载 SKILL。
- 不包含 Cadence 或 Spectre 许可/硬件。
- 首次安装需要下载 Python 依赖。
- UI 渲染依赖 DSH 版本和主题。
- 实际 SKILL/GUI 行为取决于已安装的 VBL 版本和 CIW 状态。

## 14. 许可

MIT。`virtuoso-bridge-lite/` 是 virtuoso-bridge-lite 的上游 git submodule，保留上游
MIT 许可与归属；固定提交、日期和许可记录在 `virtuoso-bridge-lite.pin.json`。
