# Virtuoso Bridge — DeepSeek Harness 插件

[English](README.md) | **简体中文**

面向 [DeepSeek Harness](https://github.com/deepseek-ai) 的持久化插件，封装
[virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite)，
把 SSH 隧道和 Virtuoso CIW 守护进程变成跨会话存活的管理运行时。

已在 npm 发布为
[`@nekomona/dsh-virtuoso-bridge`](https://www.npmjs.com/package/@nekomona/dsh-virtuoso-bridge)；
源码和问题跟踪位于
[nekomona/dsh-virtuoso-bridge](https://github.com/nekomona/dsh-virtuoso-bridge)。

插件以固定版本的 `virtuoso-bridge-lite/` **git submodule** 提供
virtuoso-bridge-lite，也可以改用本地开发仓库，或从指定 git ref 克隆。固定的是上游
精确提交 `1f186abfbb3d658211743cd707f3156ed2f59a87`（2026-11-04），其精确
时间戳和来源信息记录在 `virtuoso-bridge-lite.pin.json`；`.gitmodules` 不声明
`branch`，因此上游 `main` 更新不会改变内置源码。不要执行
`git submodule update --remote`：它是唯一会跟随移动分支的命令。npm 包内含同一份
源码，因此通过 npm 安装不需要 git 或 submodule；源码 checkout 需执行一次
`git submodule update --init virtuoso-bridge-lite`，缺失时插件会给出明确的错误提示。

详细中文指南：[`docs/plugin-guide.zh-CN.md`](docs/plugin-guide.zh-CN.md) ·
English guide: [`docs/plugin-guide.md`](docs/plugin-guide.md)

## 功能概览

| 能力 | 入口 |
| --- | --- |
| 隔离 Python 环境和工具源码 | 配置页、`virtuoso_bridge_setup` |
| SSH 连接、凭据和默认配置 | 配置页、`virtuoso_bridge_runtime` |
| 跨会话隧道/守护进程管理 | Host 运行时管理器 |
| 固定端口或自动实例发现 | 配置页、`instances` / `select_instance` |
| 连接、守护进程、智能体活动、缓存 | 右侧 **Virtuoso Bridge** 运行时面板 |
| 全部 virtuoso-bridge-lite Python API | `virtuoso_bridge_api` |
| 隔离 venv 中执行批量 Python | `virtuoso_bridge_script` |

## 安装

插件是一个 DSH bundle 包，以公开 scoped 包 **`@nekomona/dsh-virtuoso-bridge`** 发布。

### 从 npm 安装（推荐）

让智能体安装该 bundle，或使用插件管理器的 `install_bundle` 指定包名：

> Install the DSH bundle `@nekomona/dsh-virtuoso-bridge`.

不需要 submodule，也不需要 Python checkout：npm 包内含插件所需的上游工具源码，
插件会自建 venv 并从该源码 pip 安装。

### 从 git checkout 安装（开发）

```powershell
git clone --recurse-submodules https://github.com/nekomona/dsh-virtuoso-bridge.git <plugin-directory>
```

`virtuoso-bridge-lite/` 是 git submodule。如果 clone 时没有加
`--recurse-submodules`，安装前先初始化：

```powershell
git submodule update --init virtuoso-bridge-lite
```

然后让智能体安装该本地 bundle：

> Install the plugin bundle at `<plugin-directory>`.

或者通过插件管理器的 `install_bundle` 指向该目录。安装后刷新 DSH 页面以加载最新的
浏览器端 bundle。

数据目录：

```text
%USERPROFILE%\.dsh\virtuoso-bridge\<profile>\
```

`<profile>` 默认为 `default`，可由 `$DSH_PROFILE` 或 `config.dataDir` /
`VB_PLUGIN_DATA_DIR` 覆盖。

## 首次配置

打开左侧全局面板列表中的 **Virtuoso Bridge 配置**（VB 图标）。页面默认先显示
**服务器连接**；环境、默认设置、存储和活动均可折叠。

选择安装来源：

- **内置源码**（`virtuoso-bridge-lite/` submodule，默认）：安装插件固定的
  `virtuoso-bridge-lite/` git submodule，不需要访问工具仓库；首次 pip 安装仍需可访问
  Python 包索引。源码安装必须已初始化 submodule，否则插件会报错并提示执行
  `git submodule update --init virtuoso-bridge-lite`。npm 包内含同一份源码，npm 用户
  不会遇到该状态。
- **本地开发仓库**：从 `source.localRepoPath` 以 editable 方式安装，例如
  `C:\src\virtuoso-bridge-lite`。代码修改会在下次运行时启动时生效；打包元数据变化
  后使用“修复”。
- **Git 仓库**：按 `source.repoUrl` / `source.gitRef` 克隆并安装，“更新”会重新拉取。

点击安装后，插件创建私有 venv，安装工具及依赖，默认安装 SSH extra
（`paramiko` + `PySocks`），并验证 `import virtuoso_bridge`。如果系统没有 OpenSSH，
安装会暂停并询问是否仅使用 Paramiko 后端继续。

## 兼容性

- 目标 DSH 版本：当前 DSH 0.2.2 系列，Cordis 4.x。
- Host 与 Client 两半均使用标准 DSH slot/service API。
- 运行时面板、配置页、脚本工具卡和 composer 按钮均通过标准 slot 注册。
- 插件不实现自己的 Maestro runner、job store、dialog manager、history manager 或调度器；
  这些能力全部使用 virtuoso-bridge-lite / DSH 现有 API。

## 智能体说明和技能

安装完成后，插件会把技能和参考文档复制到 DSH profile 的数据目录，并在系统提示中
注册一个紧凑的 Virtuoso Bridge 段落。智能体应先阅读匹配的 `SKILL.md`：

- `skills/virtuoso/SKILL.md`
- `skills/spectre/SKILL.md`
- `skills/netlist/SKILL.md`
- `skills/optimizer/SKILL.md`
- `skills/search/SKILL.md`

`docs/agent-workflows.md` 记录现有 API 上的常见配方（Maestro job manager、对话框、
X11 关闭、保存 setup、history/job 策略），不新增引擎。

## 连接与凭据

配置页的服务器连接支持：

- 固定端口旧版守护进程；
- 自动会话/实例发现；
- 一个连接下的多个工作目录子实例；
- jump host、SSH backend、shell、Cadence 环境脚本、身份文件和角色覆盖。

连接卡上直接显示 **启动/停止**、**编辑**、**测试** 和
**部署守护进程设置**。较少使用的操作在 `⋯` 菜单中。

凭据（守护进程 token）写入 DSH credentials 服务，不写入连接配置或日志。

## 守护进程部署与覆盖

**部署守护进程设置** 只准备/上传生成的 account bootstrap，不启动隧道、不连接守护进程，
也不自动加载 SKILL。部署完成后，在目标空闲 CIW 中执行返回的：

```skill
load("/path/to/virtuoso_setup.il")
```

如果远端生成的 bundle 与本插件不同，普通部署不会覆盖。面板会显示新旧守护进程的可用
版本（未知时显示“版本未知”），并要求用户点击红色 **覆盖** 才执行替换。旧 bundle 会
保留。共享 `daemonSetup`（由 install-daemon 管理）不能被客户端覆盖。

## 工作目录子实例

一个连接可以包含多个工作目录子实例。每个子实例使用自动会话和独立 daemon port，
拥有自己的 VBL profile/sidecar，并通过工作目录发现。工具调用使用：

```json
{ "subInstance": "project-a" }
```

也可以传子实例名或绝对工作目录。右侧面板为每个子实例显示独立卡片。

## 运行时生命周期

1. 启动时建立 SSH 隧道，必要时部署 setup。
2. 守护进程未响应时，运行时进入 `waiting`；在 CIW 中加载 setup 后自动转为 `running`。
3. 守护进程可被状态检查、对话框检查和工作目录探测。
4. 停止时关闭 sidecar/tunnel；进程级管理器仍保留配置和活动记录。

状态包括：`stopped`、`starting`、`connecting`、`waiting`、`running`、`error`、
`needs-trust`。

如果 CIW 被弹窗阻塞，状态会包含对话框检查结果；面板提示用户点击/回答弹窗，而不是
误报需要重装守护进程。其他失败会显示隧道/健康检查原因。

## 缓存目录

默认缓存位于：

```text
%USERPROFILE%\.dsh\virtuoso-bridge\<profile>\
```

配置页的 **存储** 区域显示缓存根目录、可用空间，以及每项缓存的路径、大小、文件数
和清理按钮。右侧面板只显示一行存储摘要，不重复完整列表。

## 智能体工具

### `virtuoso_bridge_runtime`

管理连接和运行时：

- `status` / `list`
- `start` / `stop` / `restart`
- `ping`
- `deploy_daemon`
- `instances` / `select_instance`
- `detect_shell`
- `host_key` / `trust_host`

### `virtuoso_bridge_api`

访问全部 virtuoso-bridge-lite API：

```text
virtuoso_bridge_api action=describe target=client
virtuoso_bridge_api action=call target=client.schematic method=open_window ...
```

### `virtuoso_bridge_script`

在隔离 venv 中执行批量 Python，返回 job id、结果或结构化失败。工具卡显示脚本描述、
代码和结果，且始终可展开。

### `virtuoso_bridge_setup`

管理安装源、安装/修复/更新、诊断和缓存：

- `status` / `preflight`
- `install` / `update`
- `diagnose`
- `configure` / `set_source`
- `caches` / `clear_cache`

## 界面

### 左侧配置页

页面标题和左侧入口为 **Virtuoso Bridge 配置**。默认顺序：

1. 服务器连接
2. 环境（健康时折叠）
3. 默认设置
4. 存储
5. 活动

环境不健康时自动展开。安装日志和来源字段位于折叠区域。底部有上游项目说明：

> 本插件基于 [Arcadia-1/virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite)

### 右侧运行时面板

- 标签固定为 **Virtuoso Bridge**，窄标签由 DSH 自动裁剪。
- 环境区仅在未就绪时显示，并提供打开配置页的按钮。
- 当前会话对应的智能体排在最上方并高亮。
- 每个智能体的历史由用户手动展开/折叠；正在运行的工具始终显示。
- **最近使用** 同一行显示该智能体使用过的服务器 pill；不活跃超过 10 分钟变灰，
  超过 30 分钟不显示该 pill，但智能体行仍保留。
- 双击智能体行跳转到对应 DSH 会话。
- 顶部 **打开设置** 进入配置页；存储行不重复设置按钮。

### Composer 按钮

输入框左侧的 VB 图标显示状态点：

- 绿色：已连接；
- 黄色：等待/阻塞；
- 运行工具时呼吸绿色。

没有额外文字。

## 文件

```text
index.js                 Host plugin entry
client.js                Browser UI
lib/manager.js           Runtime/connection manager
lib/tools.js             Agent tool definitions
runtime/vb_sidecar.py    Per-runtime sidecar
runtime/vb_deploy.py     Daemon setup deployment
virtuoso-bridge-lite/    Pinned virtuoso-bridge-lite git submodule (1f186ab)
virtuoso-bridge-lite.pin.json  Upstream pin: name, version, commit, date, license
scripts/prepare-vendor.mjs  Verify/initialise the pinned submodule (prepack)
scripts/check-no-private-data.mjs  Public-release guard against private data
.github/workflows/       ci.yml (push/PR), release.yml (npm + GitHub Release),
                         upstream-watch.yml (weekly + manual upstream pin alerts)
docs/plugin-guide.md     English detailed guide
docs/plugin-guide.zh-CN.md  Chinese detailed guide
README.md                English README
README.zh-CN.md          Chinese README
```

## 验证

插件在开发中验证了：

- DSH slot/service 注册和面板加载；
- Host 工具调用、状态投影和脚本 job 流程；
- 固定端口和自动实例发现；
- 主机密钥信任流程、Paramiko/OpenSSH 后端和 jump host；
- 配置保存、来源切换、缓存路径跟随和诊断；
- 脚本工具卡、运行时面板折叠、智能体历史和连接状态；
- 守护进程冲突提示、弹窗检测、远程工作目录和双语文档；
- CI（`.github/workflows/ci.yml`）校验 `virtuoso-bridge-lite/` gitlink 与
  `virtuoso-bridge-lite.pin.json` 一致，并运行公开发布检查
  （`scripts/check-no-private-data.mjs`）。`.github/workflows/upstream-watch.yml` 每周及
  手动触发比较上游 `main` 与固定提交，不一致时创建或更新带 `upstream` 标签的 issue。

未在真实 Cadence 硬件上自动验证所有 SKILL/GUI 行为；实际效果取决于已安装的
virtuoso-bridge-lite、SSH 配置和 CIW 状态。

## 限制

- 插件不能在运行中的 Virtuoso CIW 内自动加载 SKILL；需用户执行一次 `load(...)`。
- 不包含 Cadence/Virtuoso 或 Spectre 许可。
- 首次安装需要下载 Python 依赖。
- 浏览器渲染依赖 DSH 主题和宿主版本。

## 开发

```powershell
node --check index.js
node --check client.js
node --check lib/manager.js
node --check lib/tools.js
python -m py_compile runtime/vb_sidecar.py
node --check runtime/vb_deploy.py
```

修改客户端后刷新 DSH 页面；Host 侧修改通过重新加载插件生效。

## 许可

MIT License。`virtuoso-bridge-lite/` 是 virtuoso-bridge-lite 的上游 git submodule，
保留上游的 MIT 许可与归属；上游提交、日期和许可记录在
`virtuoso-bridge-lite.pin.json`。
