/**
 * Browser half of the Virtuoso Bridge plugin.
 *
 * Registers a right-sidebar tab type ("Virtuoso Bridge"), a Settings page for
 * setup/connection/credential configuration, and a compact composer opener.
 * All state and operations go through the same Host HTTP endpoint the agent
 * tools use; the panel is a projection of the Host runtime manager.
 */
window.__ModuleLoader__.load({
  id: 'dsh-virtuoso-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'virtuosoBridge'
    const KIND = 'virtuoso-bridge'
    const TYPE_ID = 'dsh-virtuoso-bridge/dashboard'
    const BASE_PATH = '/__dsh/virtuoso-bridge'
    const SETTINGS_SECTION = 'virtuoso-bridge'

    const en = {
      'tab.title': 'Virtuoso Bridge',
      'tab.description': 'Connections, attached agents, caches and ongoing actions for virtuoso-bridge-lite.',
      'open': 'Open Virtuoso Bridge dashboard',
      'settings.title': 'Virtuoso Bridge',
      'loading': 'Loading Virtuoso Bridge state…',
      'live': 'Live',
      'polling': 'Polling',
      'refresh': 'Refresh',
      'retry': 'Retry',
      'none': 'None',
      'cancel': 'Cancel',
      'save': 'Save',
      'saving': 'Saving…',
      'delete': 'Delete',
      'edit': 'Edit',
      'test': 'Test',
      'add': 'Add',
      'start': 'Start',
      'stop': 'Stop',
      'restart': 'Restart',
      'install': 'Install',
      'repair': 'Repair',
      'update': 'Update',
      'diagnose': 'Diagnose',
      'clear': 'Clear',
      'section.connections': 'Connections and runtimes',
      'section.agents': 'Attached agents',
      'section.caches': 'Local cache storage',
      'section.actions': 'Ongoing actions',
      'section.logs': 'Recent activity',
      'section.setup': 'Environment',
      'section.defaults': 'Runtime defaults',
      'section.credentials': 'Credentials',
      'setup.installed': 'Isolated environment ready',
      'setup.notInstalled': 'The isolated virtuoso-bridge environment is not installed yet.',
      'setup.installing': 'Installing…',
      'setup.source': 'Source',
      'setup.venv': 'Virtualenv',
      'setup.python': 'Python',
      'setup.version': 'Package',
      'setup.log': 'Installation log',
      'setup.emptyLog': 'No installation has run yet.',
      'setup.error': 'Environment problem',
      'setup.mode.bundled': 'Bundled snapshot',
      'setup.mode.local': 'Local development repo',
      'setup.mode.git': 'Git repository',
      'setup.modeHint': 'Bundled works offline for the tool source; Git and local modes follow your checkout.',
      'setup.localPath': 'Local repository path',
      'setup.repoUrl': 'Git repository URL',
      'setup.gitRef': 'Git ref',
      'setup.pythonPath': 'Python executable',
      'setup.recreate': 'Recreate the virtualenv before installing',
      'conn.empty': 'No server connection yet. Add one below or in Settings → Virtuoso Bridge.',
      'conn.add': 'Add connection',
      'conn.new': 'New connection',
      'conn.name': 'Name',
      'conn.host': 'Server host',
      'conn.user': 'SSH user',
      'conn.port': 'Daemon port',
      'conn.portHint': 'Leave blank to derive it from the SSH user (the bridge uses SHA-1 of the user, 65000–65499).',
      'conn.portAuto': 'Derive port from SSH user',
      'conn.sshPort': 'SSH port',
      'conn.localPort': 'Local tunnel port',
      'conn.jumpHost': 'Jump host',
      'conn.jumpUser': 'Jump host user',
      'conn.backend': 'SSH backend',
      'conn.identityFile': 'SSH identity file',
      'conn.spectreHost': 'Spectre host',
      'conn.envShell': 'Remote shell',
      'conn.envShell.auto': 'Auto-detect',
      'conn.envShell.csh': 'csh',
      'conn.envShell.sh': 'sh',
      'conn.envShellHint': 'Auto sources the Cadence environment script under csh and sh and picks the one where virtuoso is available.',
      'conn.cadenceEnvScript': 'Cadence environment script',
      'conn.cadenceEnvScriptHint': 'VB_CADENCE_CSHRC: the site script that sets up the Cadence environment (csh or sh).',
      'conn.detectShell': 'Detect shell',
      'conn.detectedShell': 'Detected shell',
      'conn.notes': 'Notes',
      'conn.token': 'Daemon token',
      'conn.tokenStored': 'A daemon token is stored for this connection.',
      'conn.tokenHint': 'Leave blank to keep the stored value. Tokens are kept by DSH credentials and never shown again.',
      'conn.clearToken': 'Clear the stored token',
      'conn.identityHint': 'Optional. Used to write a per-connection SSH config; system ssh remains the default.',
      'conn.kind.local': 'Local Virtuoso',
      'conn.kind.remote': 'Remote server',
      'conn.ciwHint': 'Run this in the Virtuoso CIW, then refresh:',
      'conn.default': 'Default',
      'conn.autoStart': 'Start with DSH',
      'conn.deleteConfirm': 'Delete this connection? Its stored token is removed too.',
      'conn.hostKey': 'SSH host key',
      'conn.hostKeyUnknown': 'This server has not been trusted yet. Confirm the fingerprint before connecting.',
      'conn.hostKeyChanged': 'The server offered a different key than known_hosts. Verify it with the server administrator before replacing the old entry.',
      'conn.trust': 'Trust and start',
      'conn.trustHint': 'Only trust a fingerprint you verified out of band. This appends the key to your ~/.ssh/known_hosts.',
      'conn.fingerprint': 'Fingerprint',
      'conn.details': 'Failure details',
      'conn.sshPortShort': 'SSH',
      'backends.title': 'SSH backends',
      'backends.openssh': 'OpenSSH',
      'backends.paramiko': 'Paramiko',
      'backends.missing': 'not found',
      'backends.installed': 'installed',
      'backends.installAnyway': 'Install with Paramiko only',
      'backends.confirmMissing': 'OpenSSH (ssh) is not on PATH. Continue installing the Paramiko backend? The OpenSSH backend will remain unavailable until ssh is installed.',
      'backends.extraHint': 'Paramiko and PySocks are installed by default from the bridge’s ssh extra.',
      'backends.installExtra': 'Install the Paramiko SSH extra by default',
      'setup.cacheDir': 'Local cache directory',
      'setup.cacheDirHint': 'Holds pip wheels, git checkouts, script jobs and large results. The venv, settings and logs stay in the data directory. Existing files are not moved.',
      'setup.cacheDirDefault': 'Use the data directory',
      'setup.browse': 'Browse…',
      'setup.backendsTitle': 'SSH backends',
      'setup.preflight': 'Refresh backends',
      'agents.empty': 'No agent has used a runtime yet.',
      'agents.calls': 'calls',
      'agents.last': 'last used',
      'agents.live': 'live',
      'agents.offline': 'closed',
      'caches.empty': 'No cache directories yet.',
      'caches.files': 'files',
      'caches.free': 'free disk',
      'caches.truncated': 'partially measured',
      'actions.empty': 'No actions yet.',
      'actions.running': 'running',
      'logs.empty': 'No activity yet.',
      'state.starting': 'starting',
      'state.connecting': 'connecting',
      'state.waiting': 'waiting for CIW',
      'state.needs-trust': 'host key confirmation',
      'state.running': 'running',
      'state.stopping': 'stopping',
      'state.stopped': 'stopped',
      'state.error': 'error',
      'state.succeeded': 'succeeded',
      'state.failed': 'failed',
      'state.cancelled': 'cancelled',
      'state.timeout': 'timeout',
      'action.install': 'Installation',
      'action.diagnose': 'Diagnosis',
      'error.title': 'Action failed',
      'error.setup': 'Could not load the dashboard state.',
      'settings.intro': 'Configure the managed virtuoso-bridge-lite environment, server connections and durable credentials. The same operations are available to the agent through the virtuoso_bridge_* tools.',
      'settings.sourceSave': 'Save source',
      'settings.settingsSave': 'Save defaults',
      'settings.connectionSave': 'Save connection',
      'settings.installedAt': 'Installed',
      'settings.autoInstall': 'Install automatically before the first start',
      'settings.logToCiw': 'Log bridge calls to the Virtuoso CIW',
      'settings.maxScripts': 'Maximum concurrent scripts',
      'settings.defaultConnection': 'Default connection',
      'settings.autoStartHint': 'Checked connections start when DSH launches.',
      'settings.noConnections': 'No connections yet.',
      'settings.diagnostics': 'Diagnostics',
      'settings.diagnosticsOk': 'All checks passed.',
      'settings.diagnosticsFail': 'Some checks failed; see details in the tool result.',
    }

    const zh = {
      'tab.title': 'Virtuoso 桥接',
      'tab.description': 'virtuoso-bridge-lite 的连接、已接入智能体、缓存和进行中的操作。',
      'open': '打开 Virtuoso 桥接仪表盘',
      'settings.title': 'Virtuoso 桥接',
      'loading': '正在加载 Virtuoso 桥接状态…',
      'live': '实时',
      'polling': '轮询',
      'refresh': '刷新',
      'retry': '重试',
      'none': '无',
      'cancel': '取消',
      'save': '保存',
      'saving': '保存中…',
      'delete': '删除',
      'edit': '编辑',
      'test': '测试',
      'add': '添加',
      'start': '启动',
      'stop': '停止',
      'restart': '重启',
      'install': '安装',
      'repair': '修复',
      'update': '更新',
      'diagnose': '诊断',
      'clear': '清理',
      'section.connections': '连接与运行时',
      'section.agents': '已接入智能体',
      'section.caches': '本地缓存存储',
      'section.actions': '进行中的操作',
      'section.logs': '最近活动',
      'section.setup': '环境',
      'section.defaults': '运行时默认值',
      'section.credentials': '凭据',
      'setup.installed': '隔离环境已就绪',
      'setup.notInstalled': '尚未安装 virtuoso-bridge 隔离环境。',
      'setup.installing': '正在安装…',
      'setup.source': '来源',
      'setup.venv': '虚拟环境',
      'setup.python': 'Python',
      'setup.version': '软件包',
      'setup.log': '安装日志',
      'setup.emptyLog': '尚未执行安装。',
      'setup.error': '环境问题',
      'setup.mode.bundled': '内置快照',
      'setup.mode.local': '本地开发仓库',
      'setup.mode.git': 'Git 仓库',
      'setup.modeHint': '内置模式可离线使用工具源码；Git 与本地模式跟随你的仓库。',
      'setup.localPath': '本地仓库路径',
      'setup.repoUrl': 'Git 仓库地址',
      'setup.gitRef': 'Git 引用',
      'setup.pythonPath': 'Python 可执行文件',
      'setup.recreate': '安装前重建虚拟环境',
      'setup.cacheDir': '本地缓存目录',
      'setup.cacheDirHint': '存放 pip 轮子、Git 检出、脚本任务和大结果。虚拟环境、设置和日志仍留在数据目录。现有文件不会移动。',
      'setup.cacheDirDefault': '使用数据目录',
      'setup.browse': '浏览…',
      'setup.backendsTitle': 'SSH 后端',
      'setup.preflight': '刷新后端',
      'conn.empty': '尚无服务器连接。在下方或“设置 → Virtuoso 桥接”中添加。',
      'conn.add': '添加连接',
      'conn.new': '新连接',
      'conn.name': '名称',
      'conn.host': '服务器主机',
      'conn.user': 'SSH 用户',
      'conn.port': '守护进程端口',
      'conn.portHint': '留空则按 SSH 用户名生成（桥接使用用户名的 SHA-1，范围 65000–65499）。',
      'conn.portAuto': '按 SSH 用户名生成端口',
      'conn.sshPort': 'SSH 端口',
      'conn.localPort': '本地隧道端口',
      'conn.jumpHost': '跳板机',
      'conn.jumpUser': '跳板机用户',
      'conn.backend': 'SSH 后端',
      'conn.identityFile': 'SSH 私钥文件',
      'conn.spectreHost': 'Spectre 主机',
      'conn.envShell': '远端 shell',
      'conn.envShell.auto': '自动检测',
      'conn.envShell.csh': 'csh',
      'conn.envShell.sh': 'sh',
      'conn.envShellHint': '自动在 csh 与 sh 下加载 Cadence 环境脚本，并选择能找到 virtuoso 的那个。',
      'conn.cadenceEnvScript': 'Cadence 环境脚本',
      'conn.cadenceEnvScriptHint': 'VB_CADENCE_CSHRC：用于设置 Cadence 环境的站点脚本（csh 或 sh）。',
      'conn.detectShell': '检测 shell',
      'conn.detectedShell': '已检测 shell',
      'conn.notes': '备注',
      'conn.token': '守护进程令牌',
      'conn.tokenStored': '此连接已存储守护进程令牌。',
      'conn.tokenHint': '留空表示保留已存值。令牌由 DSH 凭据服务保存，之后不会显示。',
      'conn.clearToken': '清除已存令牌',
      'conn.identityHint': '可选。用于生成该连接专用的 SSH 配置；默认仍使用系统 ssh。',
      'conn.kind.local': '本地 Virtuoso',
      'conn.kind.remote': '远程服务器',
      'conn.ciwHint': '在 Virtuoso CIW 中执行以下命令后刷新：',
      'conn.default': '默认',
      'conn.autoStart': '随 DSH 启动',
      'conn.deleteConfirm': '删除此连接？已存储的令牌也会被移除。',
      'conn.hostKey': 'SSH 主机密钥',
      'conn.hostKeyUnknown': '此服务器尚未被信任。连接前请确认指纹。',
      'conn.hostKeyChanged': '服务器提供的密钥与 known_hosts 不同。请先与管理员核实，再替换旧条目。',
      'conn.trust': '信任并启动',
      'conn.trustHint': '只信任你已通过其他渠道核实的指纹。这会把密钥追加到 ~/.ssh/known_hosts。',
      'conn.fingerprint': '指纹',
      'conn.details': '失败详情',
      'conn.sshPortShort': 'SSH',
      'backends.title': 'SSH 后端',
      'backends.openssh': 'OpenSSH',
      'backends.paramiko': 'Paramiko',
      'backends.missing': '未找到',
      'backends.installed': '已安装',
      'backends.installAnyway': '仅使用 Paramiko 安装',
      'backends.confirmMissing': 'PATH 中未找到 OpenSSH（ssh）。是否继续安装 Paramiko 后端？OpenSSH 后端在安装 ssh 之前不可用。',
      'backends.extraHint': '默认会从桥接的 ssh extra 安装 Paramiko 与 PySocks。',
      'backends.installExtra': '默认安装 Paramiko SSH 扩展',
      'agents.empty': '尚无智能体使用运行时。',
      'agents.calls': '次调用',
      'agents.last': '最近使用',
      'agents.live': '在线',
      'agents.offline': '已关闭',
      'caches.empty': '尚无缓存目录。',
      'caches.files': '个文件',
      'caches.free': '可用空间',
      'caches.truncated': '部分统计',
      'actions.empty': '尚无操作。',
      'actions.running': '进行中',
      'logs.empty': '尚无活动。',
      'state.starting': '启动中',
      'state.connecting': '连接中',
      'state.waiting': '等待 CIW',
      'state.needs-trust': '等待确认主机密钥',
      'state.running': '运行中',
      'state.stopping': '停止中',
      'state.stopped': '已停止',
      'state.error': '错误',
      'state.succeeded': '成功',
      'state.failed': '失败',
      'state.cancelled': '已取消',
      'state.timeout': '超时',
      'action.install': '安装',
      'action.diagnose': '诊断',
      'error.title': '操作失败',
      'error.setup': '无法加载仪表盘状态。',
      'settings.intro': '配置受管的 virtuoso-bridge-lite 环境、服务器连接和持久凭据。智能体可通过 virtuoso_bridge_* 工具执行相同操作。',
      'settings.sourceSave': '保存来源',
      'settings.settingsSave': '保存默认值',
      'settings.connectionSave': '保存连接',
      'settings.installedAt': '安装时间',
      'settings.autoInstall': '首次启动前自动安装',
      'settings.logToCiw': '将桥接调用记录到 Virtuoso CIW',
      'settings.maxScripts': '最大并发脚本数',
      'settings.defaultConnection': '默认连接',
      'settings.autoStartHint': '勾选的连接会在 DSH 启动时自动启动。',
      'settings.noConnections': '尚无连接。',
      'settings.diagnostics': '诊断',
      'settings.diagnosticsOk': '所有检查通过。',
      'settings.diagnosticsFail': '部分检查失败；详见工具返回结果。',
    }

    const CSS = `
.vb-root{align-self:stretch;display:flex;flex-direction:column;gap:12px;padding:14px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.45;box-sizing:border-box;min-height:100%}
.vb-root *{box-sizing:border-box}
.vb-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.vb-title{font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;min-width:0}
.vb-sub{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vb-live{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.vb-live-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.vb-live-dot.off{background:var(--dsw-alias-state-idle-primary)}
.vb-section{display:flex;flex-direction:column;gap:8px;min-width:0}
.vb-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.vb-section-title{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.vb-count{color:var(--dsw-alias-label-secondary);font-size:11px}
.vb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px;min-width:0}
.vb-card.flat{background:transparent}
.vb-row{display:flex;align-items:center;gap:8px;min-width:0}
.vb-between{justify-content:space-between}
.vb-wrap{flex-wrap:wrap}
.vb-gap4{gap:4px}.vb-gap6{gap:6px}
.vb-grow{flex:1;min-width:0}
.vb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.vb-muted{color:var(--dsw-alias-label-secondary);font-size:11px}
.vb-strong{font-weight:600}
.vb-ellipsis{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.vb-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.vb-dot.running{background:var(--dsw-alias-state-success-primary)}
.vb-dot.waiting{background:var(--dsw-alias-state-warn-primary)}
.vb-dot.needs-trust{background:var(--dsw-alias-state-warn-primary)}
.vb-dot.starting,.vb-dot.connecting,.vb-dot.stopping{background:var(--dsw-alias-brand-primary)}
.vb-dot.error{background:var(--dsw-alias-state-error-primary)}
.vb-pill{display:inline-flex;align-items:center;border-radius:999px;padding:1px 7px;font-size:10px;line-height:1.6;white-space:nowrap;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.vb-pill.running,.vb-pill.succeeded{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.vb-pill.waiting{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.vb-pill.needs-trust{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.vb-pill.error,.vb-pill.failed,.vb-pill.timeout{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.vb-pill.starting,.vb-pill.connecting,.vb-pill.stopping{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.vb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:3px 9px;font-size:11px;line-height:1.5;cursor:pointer;font-family:inherit;white-space:nowrap}
.vb-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.vb-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.vb-btn[disabled]{opacity:.5;cursor:default}
.vb-btn.primary{background:transparent;border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.vb-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.vb-btn.ghost{background:transparent}
.vb-hint{border-left:2px solid var(--dsw-alias-state-warn-primary);padding:4px 8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:0 6px 6px 0;font-size:11px}
.vb-error{color:var(--dsw-alias-state-error-primary);font-size:11px;word-break:break-word}
.vb-banner{border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:8px 10px;font-size:11px;display:flex;align-items:flex-start;gap:8px}
.vb-warn{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;padding:9px 10px;font-size:11px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}
.vb-ok{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;font-size:11px;background:var(--dsw-alias-bg-layer-1)}
.vb-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;background:var(--dsw-alias-bg-layer-2);border-radius:5px;padding:2px 5px;word-break:break-all}
.vb-pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:1.5;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
.vb-input{width:100%;appearance:none;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:11px;font-family:inherit;line-height:1.5}
.vb-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:0}
.vb-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.vb-label{font-size:10px;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.04em}
.vb-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.vb-grid.one{grid-template-columns:1fr}
.vb-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-primary)}
.vb-check input{accent-color:var(--dsw-alias-brand-primary);margin:0}
.vb-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.vb-spacer{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}
.vb-agent{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.vb-agent:last-child{border-bottom:none}
.vb-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.vb-logline{display:flex;gap:8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;padding:2px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.vb-logline:last-child{border-bottom:none}
.vb-logtime{color:var(--dsw-alias-label-secondary);flex:none}
.vb-logmsg{min-width:0;word-break:break-word}
.vb-logline.warn .vb-logmsg{color:var(--dsw-alias-state-warn-primary)}
.vb-logline.error .vb-logmsg{color:var(--dsw-alias-state-error-primary)}
.vb-settings{padding:18px 22px;gap:18px;max-width:900px}
.vb-settings .vb-card{padding:14px 16px;gap:12px}
.vb-settings .vb-section-title{font-size:12px}
.vb-open{appearance:none;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
.vb-open:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.vb-open:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.vb-open svg{width:16px;height:16px;display:block}
@media (max-width:520px){.vb-grid{grid-template-columns:1fr}.vb-settings{padding:14px}}
`

    function bridgeGlobal() {
      try {
        return globalThis.__DSH_VIRTUOSO_BRIDGE__
      } catch {
        return undefined
      }
    }

    const session = { base: undefined, token: undefined, resolving: undefined, lastError: undefined }

    function configuredBase() {
      return bridgeGlobal()?.basePath || BASE_PATH
    }

    function candidateBases() {
      const global = bridgeGlobal()
      const bases = []
      const add = (value) => {
        if (!value) return
        const text = String(value).replace(/\/+$/, '')
        if (text && !bases.includes(text)) bases.push(text)
      }
      if (global?.origin) add(`${String(global.origin).replace(/\/+$/, '')}${global.basePath || BASE_PATH}`)
      if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
        add(`${location.origin}${global?.basePath || BASE_PATH}`)
      }
      add(configuredBase())
      if (String(configuredBase()).startsWith('/')) add(String(configuredBase()).slice(1))
      return bases
    }

    async function bootstrapAt(base) {
      const response = await fetch(`${base}/bootstrap`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      if (!response.ok) return undefined
      let data
      try {
        data = await response.json()
      } catch {
        return undefined
      }
      return data?.ok ? data : undefined
    }

    async function ensureSession(force = false) {
      if (!force && session.base && session.token) return session
      if (session.resolving) return session.resolving
      session.resolving = (async () => {
        const problems = []
        for (const base of candidateBases()) {
          try {
            const data = await bootstrapAt(base)
            if (data) {
              session.base = base
              session.token = data.token || bridgeGlobal()?.token
              session.lastError = undefined
              return session
            }
            problems.push(`${base} → no bootstrap`)
          } catch (error) {
            problems.push(`${base} → ${error?.message || error}`)
          }
        }
        const global = bridgeGlobal()
        session.base =
          session.base ||
          (global?.origin ? `${String(global.origin).replace(/\/+$/, '')}${global.basePath || BASE_PATH}` : configuredBase())
        session.token = session.token || global?.token
        session.lastError = problems.slice(0, 3).join('; ') || 'no dashboard endpoint answered'
        return session
      })().finally(() => {
        session.resolving = undefined
      })
      return session.resolving
    }

    async function rawRequest(base, token, path, options) {
      const headers = { accept: 'application/json', ...(options.headers || {}) }
      if (options.body !== undefined) headers['content-type'] = 'application/json'
      if (token) headers['x-vb-token'] = token
      const url = new URL(`${base}${path}`, typeof location !== 'undefined' ? location.href : undefined)
      if (token) url.searchParams.set('token', token)
      const response = await fetch(url.toString(), {
        method: options.method || 'GET',
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      let data
      try {
        data = await response.json()
      } catch {
        const failure = new Error(`HTTP ${response.status} from ${url.pathname}`)
        failure.status = response.status
        throw failure
      }
      if (!response.ok || data?.ok === false) {
        const failure = new Error(data?.error?.message || `HTTP ${response.status}`)
        failure.status = response.status
        failure.code = data?.error?.code
        throw failure
      }
      return data
    }

    async function request(path, options = {}) {
      let lastError
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = await ensureSession(attempt > 0)
        try {
          return await rawRequest(current.base, current.token, path, options)
        } catch (error) {
          lastError = error
          if (error?.status === 403) {
            session.token = undefined
            continue
          }
          if (error?.status === 404) {
            session.base = undefined
            continue
          }
          throw error
        }
      }
      const page = typeof location !== 'undefined' ? location.href : '(no location)'
      const tried = candidateBases().join(', ')
      throw new Error(
        `${lastError?.message || 'dashboard request failed'} [page ${page}; tried ${tried}; ${session.lastError || 'no bootstrap'}]`,
      )
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let size = value
      let unit = 0
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024
        unit += 1
      }
      return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`
    }

    function relativeTime(value) {
      if (!value) return '—'
      const seconds = Math.max(0, Math.round((Date.now() - Number(value)) / 1000))
      if (seconds < 5) return 'just now'
      if (seconds < 60) return `${seconds}s ago`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m ago`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h ago`
      return `${Math.floor(hours / 24)}d ago`
    }

    function shortId(value) {
      const text = String(value || '')
      if (text.length <= 10) return text
      return `${text.slice(0, 6)}…${text.slice(-4)}`
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const styleElement = h('style', null, CSS)

      function label(key) {
        const value = t(key)
        return value && value !== key ? value : key
      }

      function stateLabel(state) {
        return label(`state.${state}`)
      }

      function Pill(props) {
        return h('span', { className: `vb-pill ${props.state || ''}` }, props.children || stateLabel(props.state))
      }

      function Button(props) {
        return h(
          'button',
          {
            type: 'button',
            className: `vb-btn${props.tone ? ` ${props.tone}` : ''}`,
            disabled: props.disabled,
            title: props.title,
            onClick: props.onClick,
          },
          props.children,
        )
      }

      function Section(props) {
        return h(
          'section',
          { className: 'vb-section' },
          h(
            'div',
            { className: 'vb-section-head' },
            h('div', { className: 'vb-section-title' }, props.title),
            props.actions || (props.count !== undefined ? h('span', { className: 'vb-count' }, String(props.count)) : null),
          ),
          props.children,
        )
      }

      function useBridgeState() {
        const [state, setState] = React.useState(null)
        const [error, setError] = React.useState('')
        const [live, setLive] = React.useState(false)
        const [nonce, setNonce] = React.useState(0)
        const reload = React.useCallback(() => setNonce((value) => value + 1), [])
        React.useEffect(() => {
          let disposed = false
          let source
          let timer
          async function load() {
            try {
              const data = await request('/state')
              if (disposed) return
              setState(data.state)
              setError('')
            } catch (failure) {
              if (!disposed) setError(failure.message)
            }
          }
          load()
          ;(async () => {
            try {
              const current = await ensureSession()
              if (disposed) return
              const url = `${current.base}/events${current.token ? `?token=${encodeURIComponent(current.token)}` : ''}`
              source = new EventSource(url)
              source.onopen = () => setLive(true)
              source.onmessage = (event) => {
                try {
                  const payload = JSON.parse(event.data)
                  if (payload?.type === 'state' && payload.state) {
                    setState(payload.state)
                    setLive(true)
                    setError('')
                  }
                } catch {
                  // ignore malformed frames
                }
              }
              source.onerror = () => setLive(false)
            } catch {
              setLive(false)
            }
          })()
          timer = setInterval(load, 5000)
          return () => {
            disposed = true
            clearInterval(timer)
            try {
              source?.close()
            } catch {
              // ignore
            }
          }
        }, [nonce])
        return { state, error, live, reload }
      }

      function useAction(reload) {
        const [busy, setBusy] = React.useState('')
        const [error, setError] = React.useState('')
        const invoke = React.useCallback(
          async (action, payload) => {
            setBusy(action)
            setError('')
            try {
              const data = await request('/action', { method: 'POST', body: { action, payload } })
              reload()
              return data.result
            } catch (failure) {
              setError(failure.message)
              return undefined
            } finally {
              setBusy('')
            }
          },
          [reload],
        )
        return { busy, error, invoke, clearError: () => setError('') }
      }

      function ErrorBanner(props) {
        if (!props.message) return null
        return h(
          'div',
          { className: 'vb-banner' },
          h('span', { className: 'vb-grow' }, h('strong', null, `${label('error.title')}: `), props.message),
          props.onRetry ? h(Button, { onClick: props.onRetry }, label('retry')) : null,
        )
      }

      function RuntimeActions(props) {
        const { connection, runtime, busy, invoke, t: translate } = props
        const state = runtime?.state || 'stopped'
        const disabled = Boolean(busy)
        const start = () => invoke('runtime.start', { connection: connection.id, waitMs: 15000 })
        const stop = () => invoke('runtime.stop', { connection: connection.id, runtime: runtime?.id })
        const restart = () => invoke('runtime.restart', { connection: connection.id, waitMs: 15000 })
        const test = async () => {
          const result = await invoke('connection.test', { connection: connection.id })
          props.onTestResult?.(result)
        }
        if (state === 'needs-trust') {
          return h('div', { className: 'vb-actions' }, h(Button, { disabled, onClick: test }, label('test')))
        }
        return h(
          'div',
          { className: 'vb-actions' },
          ['stopped', 'error'].includes(state)
            ? h(Button, { tone: 'primary', disabled, onClick: start }, label('start'))
            : h(Button, { disabled, onClick: stop }, label('stop')),
          ['running', 'waiting'].includes(state) ? h(Button, { disabled, onClick: restart }, label('restart')) : null,
          h(Button, { disabled, onClick: test }, label('test')),
        )
      }

      function HostKeyPrompt(props) {
        const { connection, pending, busy, invoke } = props
        if (!pending) return null
        const trust = async (fingerprint) => {
          const result = await invoke('runtime.trust_host', { connection: connection.id, fingerprint })
          if (result?.trust?.trusted === false) return
          await invoke('runtime.start', { connection: connection.id, waitMs: 15000 })
        }
        const conflicts = pending.conflicts ?? []
        const unknown = pending.unknown ?? []
        return h(
          'div',
          { className: 'vb-warn' },
          h('div', { className: 'vb-strong' }, label('conn.hostKey')),
          h('div', null, conflicts.length ? label('conn.hostKeyChanged') : label('conn.hostKeyUnknown')),
          conflicts.length
            ? conflicts.map((conflict) =>
                h(
                  'div',
                  { className: 'vb-error', key: conflict.incoming?.fingerprint },
                  `${conflict.incoming?.type || ''} ${conflict.incoming?.fingerprint || ''} — known: ${(conflict.existing || []).map((item) => item.fingerprint).join(', ')}`,
                ),
              )
            : null,
          unknown.map((entry) =>
            h(
              'div',
              { className: 'vb-row vb-between vb-wrap', key: entry.fingerprint },
              h('span', { className: 'vb-mono' }, `${entry.type} ${entry.fingerprint}`),
              h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: () => trust(entry.fingerprint) }, label('conn.trust')),
            ),
          ),
          h('div', { className: 'vb-muted' }, label('conn.trustHint')),
        )
      }

      function ConnectionCard(props) {
        const { connection, runtime, busy, invoke } = props
        const state = runtime?.state || 'stopped'
        const agents = runtime?.agents || []
        const [testInfo, setTestInfo] = React.useState(null)
        const pending = runtime?.pendingHostKey ?? testInfo?.pendingHostKey
        return h(
          'div',
          { className: 'vb-card' },
          h(
            'div',
            { className: 'vb-row vb-between vb-wrap' },
            h(
              'div',
              { className: 'vb-row vb-grow' },
              h('span', { className: `vb-dot ${state}` }),
              h('span', { className: 'vb-strong vb-ellipsis' }, connection.name),
              h(Pill, { state }),
              connection.hasSecret ? h('span', { className: 'vb-chip', title: label('conn.tokenStored') }, 'token') : null,
            ),
            h(RuntimeActions, { connection, runtime, busy, invoke, onTestResult: setTestInfo }),
          ),
          h(
            'div',
            { className: 'vb-mono vb-muted vb-ellipsis' },
            `${connection.kind === 'local' ? label('conn.kind.local') : label('conn.kind.remote')} · ${connection.user ? `${connection.user}@` : ''}${connection.host}:${connection.port} · ${label('conn.sshPortShort')} ${connection.sshPort || 22} · ${connection.envShell || 'auto'}${connection.jumpHost ? ` via ${connection.jumpHost}` : ''}`,
          ),
          h(HostKeyPrompt, { connection, pending, busy, invoke }),
          testInfo && !testInfo.ok
            ? h('div', { className: 'vb-error' }, `SSH test: ${testInfo.detail || 'failed'}`)
            : testInfo?.ok
              ? h('div', { className: 'vb-muted' }, testInfo.detail || 'SSH test succeeded')
              : null,
          runtime?.health?.summary ? h('div', { className: 'vb-muted' }, runtime.health.summary) : null,
          runtime?.setupHint
            ? h(
                'div',
                { className: 'vb-hint' },
                label('conn.ciwHint'),
                ' ',
                h('code', { className: 'vb-code' }, runtime.setupHint),
              )
            : null,
          runtime?.error ? h('div', { className: 'vb-error' }, runtime.error) : null,
          runtime?.stage ? h('div', { className: 'vb-muted' }, `stage: ${runtime.stage}`) : null,
          runtime?.errorDetail
            ? h(
                'details',
                { className: 'vb-field' },
                h('summary', { className: 'vb-muted' }, label('conn.details')),
                h('pre', { className: 'vb-pre' }, JSON.stringify(runtime.errorDetail, null, 2)),
              )
            : null,
          runtime?.pending ? h('div', { className: 'vb-muted' }, `${label('state.starting')}…`) : null,
          agents.length
            ? h(
                'div',
                { className: 'vb-row vb-wrap vb-gap4' },
                agents.slice(0, 4).map((agent) =>
                  h('span', { className: 'vb-chip', key: agent.sessionId, title: `${agent.calls} ${label('agents.calls')}` }, shortId(agent.sessionId)),
                ),
                agents.length > 4 ? h('span', { className: 'vb-chip' }, `+${agents.length - 4}`) : null,
              )
            : null,
        )
      }

      function SetupBanner(props) {
        const { setup, busy, invoke } = props
        const [prompt, setPrompt] = React.useState(null)
        if (!setup) return null
        const install = async (confirm = false) => {
          const result = await invoke('setup.install', { confirm })
          if (result?.needsConfirmation) setPrompt(result)
          else setPrompt(null)
        }
        const backends = setup.backends
        const backendLine = backends
          ? `${label('backends.openssh')}: ${backends.openssh?.available ? backends.openssh.version || 'ok' : label('backends.missing')} · ${label('backends.paramiko')}: ${backends.paramiko?.installed ? backends.paramiko.version || label('backends.installed') : label('backends.missing')}`
          : null
        const promptCard = prompt
          ? h(
              'div',
              { className: 'vb-warn' },
              h('div', null, prompt.message || label('backends.confirmMissing')),
              h(
                'div',
                { className: 'vb-actions' },
                h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: () => install(true) }, label('backends.installAnyway')),
                h(Button, { disabled: Boolean(busy), onClick: () => setPrompt(null) }, label('cancel')),
              ),
            )
          : null
        if (setup.installed) {
          return h(
            'div',
            { className: 'vb-ok' },
            h('div', { className: 'vb-row vb-between vb-wrap' },
              h('span', null, h('strong', null, `${label('setup.installed')}`), ` · ${setup.source?.mode ?? ''}${setup.venv?.package?.version ? ` · v${setup.venv.package.version}` : ''}`),
              h('span', { className: 'vb-muted vb-ellipsis' }, setup.venv?.path || ''),
            ),
            backendLine ? h('div', { className: 'vb-muted' }, backendLine) : null,
            backends?.openssh?.available === false
              ? h('div', { className: 'vb-error' }, label('backends.confirmMissing'))
              : null,
            promptCard,
          )
        }
        return h(
          'div',
          { className: 'vb-warn' },
          h('div', null, label('setup.notInstalled')),
          backendLine ? h('div', { className: 'vb-muted' }, backendLine) : null,
          h(
            'div',
            { className: 'vb-row vb-wrap' },
            h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: () => install(false) }, busy ? label('setup.installing') : label('install')),
            h(Button, { disabled: Boolean(busy), onClick: () => invoke('setup.refresh', {}) }, label('refresh')),
            setup.error ? h('span', { className: 'vb-error' }, setup.error) : null,
          ),
          promptCard,
        )
      }

      function DashboardBody() {
        const { state, error, live, reload } = useBridgeState()
        const { busy, error: actionError, invoke } = useAction(reload)
        if (!state) {
          return h(
            'div',
            { className: 'vb-root' },
            styleElement,
            h('div', { className: 'vb-muted' }, error || label('loading')),
            error ? h(Button, { onClick: reload }, label('retry')) : null,
          )
        }
        const setup = state.setup || {}
        const connections = state.connections || []
        const runtimes = state.runtimes || []
        const actions = state.actions || []
        const agents = state.agents || []
        const caches = state.caches || []
        const logs = state.logs || []
        const running = actions.filter((action) => action.state === 'running')
        const recent = actions.filter((action) => action.state !== 'running').slice(0, 8)
        return h(
          'div',
          { className: 'vb-root' },
          styleElement,
          h(
            'div',
            { className: 'vb-top' },
            h(
              'div',
              { className: 'vb-title vb-grow' },
              h('span', null, label('tab.title')),
              h('span', { className: 'vb-live' }, h('span', { className: `vb-live-dot${live ? '' : ' off'}` }), live ? label('live') : label('polling')),
            ),
            h(Button, { onClick: reload, disabled: Boolean(busy) }, label('refresh')),
          ),
          h(ErrorBanner, { message: error || actionError, onRetry: reload }),
          h(SetupBanner, { setup, busy, invoke }),
          h(
            Section,
            { title: label('section.connections'), count: connections.length },
            connections.length
              ? connections.map((connection) =>
                  h(ConnectionCard, {
                    key: connection.id,
                    connection,
                    runtime: runtimes.find((runtime) => runtime.connectionId === connection.id || runtime.id === connection.runtimeId),
                    busy,
                    invoke,
                  }),
                )
              : h('div', { className: 'vb-card flat vb-muted' }, label('conn.empty')),
          ),
          h(
            Section,
            { title: label('section.agents'), count: agents.length },
            agents.length
              ? h(
                  'div',
                  { className: 'vb-card' },
                  agents.map((agent) =>
                    h(
                      'div',
                      { className: 'vb-agent', key: agent.sessionId },
                      h(
                        'div',
                        { className: 'vb-row vb-grow' },
                        h('span', { className: `vb-dot ${agent.live ? 'running' : ''}` }),
                        h('span', { className: 'vb-mono vb-ellipsis', title: String(agent.sessionId) }, shortId(agent.sessionId)),
                        h('span', { className: 'vb-muted' }, `${agent.calls} ${label('agents.calls')}`),
                      ),
                      h('span', { className: 'vb-muted' }, `${label('agents.last')} ${relativeTime(agent.lastUsedAt)}`),
                    ),
                  ),
                )
              : h('div', { className: 'vb-card flat vb-muted' }, label('agents.empty')),
          ),
          h(
            Section,
            { title: label('section.actions'), count: running.length },
            h(
              'div',
              { className: 'vb-card' },
              running.length
                ? running.map((action) =>
                    h(
                      'div',
                      { className: 'vb-row vb-between', key: action.id },
                      h('div', { className: 'vb-row vb-grow' }, h('span', { className: 'vb-dot starting' }), h('span', { className: 'vb-ellipsis' }, action.label || action.kind)),
                      h('span', { className: 'vb-muted' }, relativeTime(action.startedAt)),
                    ),
                  )
                : h('div', { className: 'vb-muted' }, label('actions.empty')),
              recent.length
                ? h(
                    'div',
                    null,
                    h('div', { className: 'vb-spacer' }),
                    recent.map((action) =>
                      h(
                        'div',
                        { className: 'vb-row vb-between', key: action.id },
                        h('div', { className: 'vb-row vb-grow' }, h('span', { className: `vb-dot ${action.state === 'succeeded' ? 'running' : 'error'}` }), h('span', { className: 'vb-ellipsis' }, action.label || action.kind)),
                        h(Pill, { state: action.state }),
                      ),
                    ),
                  )
                : null,
            ),
          ),
          h(
            Section,
            {
              title: label('section.caches'),
              count: caches.length,
              actions: h(Button, { onClick: () => invoke('cache.refresh', {}) }, label('refresh')),
            },
            caches.length
              ? h(
                  'div',
                  { className: 'vb-card' },
                  state.disk
                    ? h('div', { className: 'vb-muted' }, `${formatBytes(state.disk.free)} ${label('caches.free')} · ${state.cacheDir || state.dataDir}`)
                    : null,
                  caches.map((cache) =>
                    h(
                      'div',
                      { className: 'vb-row vb-between vb-wrap', key: cache.id },
                      h(
                        'div',
                        { className: 'vb-grow' },
                        h('div', { className: 'vb-ellipsis' }, cache.label),
                        h('div', { className: 'vb-mono vb-muted vb-ellipsis', title: cache.path }, cache.path),
                      ),
                      h(
                        'div',
                        { className: 'vb-row vb-gap6' },
                        h('span', { className: 'vb-muted' }, `${formatBytes(cache.bytes)}${cache.files ? ` · ${cache.files} ${label('caches.files')}` : ''}${cache.truncated ? ` · ${label('caches.truncated')}` : ''}`),
                        cache.clearable ? h(Button, { disabled: Boolean(busy), onClick: () => invoke('cache.clear', { cache: cache.id }) }, label('clear')) : null,
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'vb-card flat vb-muted' }, label('caches.empty')),
          ),
          h(
            Section,
            { title: label('section.logs'), count: logs.length },
            logs.length
              ? h(
                  'div',
                  { className: 'vb-card' },
                  logs
                    .slice(-14)
                    .reverse()
                    .map((entry, index) =>
                      h(
                        'div',
                        { className: `vb-logline ${entry.level || 'info'}`, key: `${entry.time}-${index}` },
                        h('span', { className: 'vb-logtime' }, new Date(entry.time).toLocaleTimeString()),
                        h('span', { className: 'vb-logmsg' }, entry.message),
                      ),
                    ),
                )
              : h('div', { className: 'vb-card flat vb-muted' }, label('logs.empty')),
          ),
        )
      }

      function TextField(props) {
        const { label: text, hint, ...rest } = props
        return h(
          'label',
          { className: 'vb-field' },
          h('span', { className: 'vb-label' }, text),
          h('input', { className: 'vb-input', ...rest }),
          hint ? h('span', { className: 'vb-muted' }, hint) : null,
        )
      }

      function SelectField(props) {
        const { label: text, hint, children, ...rest } = props
        return h(
          'label',
          { className: 'vb-field' },
          h('span', { className: 'vb-label' }, text),
          h('select', { className: 'vb-input', ...rest }, children),
          hint ? h('span', { className: 'vb-muted' }, hint) : null,
        )
      }

      function CheckField(props) {
        return h(
          'label',
          { className: 'vb-check' },
          h('input', { type: 'checkbox', checked: props.checked, onChange: props.onChange, disabled: props.disabled }),
          h('span', null, props.children),
        )
      }

      function ConnectionEditor(props) {
        const { draft, setDraft, onSave, onCancel, busy, hasSecret } = props
        const update = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })
        const [derivePort, setDerivePort] = React.useState(draft.port === '' || draft.port === undefined)
        return h(
          'div',
          { className: 'vb-card' },
          h('div', { className: 'vb-strong' }, draft.id ? label('conn.edit') : label('conn.new')),
          h(
            'div',
            { className: 'vb-grid' },
            h(TextField, { label: label('conn.name'), value: draft.name, onChange: update('name'), placeholder: 'lab-virtuoso' }),
            h(TextField, { label: label('conn.host'), value: draft.host, onChange: update('host'), placeholder: 'gpu01.example.com' }),
            h(TextField, { label: label('conn.user'), value: draft.user || '', onChange: update('user'), placeholder: 'designer' }),
            h(TextField, { label: label('conn.port'), value: draft.port ?? '', onChange: update('port'), inputMode: 'numeric', hint: label('conn.portHint'), placeholder: 'auto from SSH user', disabled: derivePort }),
            h(CheckField, { checked: derivePort, onChange: (event) => { setDerivePort(event.target.checked); if (event.target.checked) setDraft({ ...draft, port: '' }) } }, label('conn.portAuto')),
            h(TextField, { label: label('conn.sshPort'), value: draft.sshPort ?? 22, onChange: update('sshPort'), inputMode: 'numeric' }),
            h(TextField, { label: label('conn.localPort'), value: draft.localPort ?? '', onChange: update('localPort'), inputMode: 'numeric', placeholder: 'optional' }),
            h(TextField, { label: label('conn.jumpHost'), value: draft.jumpHost || '', onChange: update('jumpHost'), placeholder: 'optional' }),
            h(TextField, { label: label('conn.jumpUser'), value: draft.jumpUser || '', onChange: update('jumpUser'), placeholder: 'optional' }),
            h(TextField, { label: label('conn.spectreHost'), value: draft.spectreHost || '', onChange: update('spectreHost'), placeholder: 'optional' }),
            h(SelectField, { label: label('conn.backend'), value: draft.sshBackend || 'openssh', onChange: update('sshBackend') },
              h('option', { value: 'openssh' }, 'openssh'),
              h('option', { value: 'paramiko' }, 'paramiko'),
            ),
            h(SelectField, { label: label('conn.envShell'), value: draft.envShell || 'auto', onChange: update('envShell'), hint: label('conn.envShellHint') },
              h('option', { value: 'auto' }, label('conn.envShell.auto')),
              h('option', { value: 'csh' }, 'csh'),
              h('option', { value: 'sh' }, 'sh'),
            ),
            h(TextField, { label: label('conn.cadenceEnvScript'), value: draft.cadenceEnvScript || '', onChange: update('cadenceEnvScript'), hint: label('conn.cadenceEnvScriptHint'), placeholder: '/site/cadence/setup.csh' }),
            h(TextField, { label: label('conn.identityFile'), value: draft.identityFile || '', onChange: update('identityFile'), hint: label('conn.identityHint'), placeholder: 'C:\\Users\\me\\.ssh\\id_ed25519' }),
            h(TextField, { label: label('conn.notes'), value: draft.notes || '', onChange: update('notes') }),
          ),
          h(
            'div',
            { className: 'vb-row vb-wrap' },
            h(Button, { disabled: Boolean(busy) || !draft.cadenceEnvScript || !draft.id, onClick: () => props.onDetectShell?.(draft) }, label('conn.detectShell')),
            draft.detectedShell
              ? h('span', { className: 'vb-chip' }, `${label('conn.detectedShell')}: ${draft.detectedShell}`)
              : null,
            props.detectMessage ? h('span', { className: 'vb-error' }, props.detectMessage) : null,
          ),
          h(
            'div',
            { className: 'vb-field' },
            h('span', { className: 'vb-label' }, label('conn.token')),
            h('input', {
              className: 'vb-input',
              type: 'password',
              autoComplete: 'off',
              value: props.token,
              placeholder: hasSecret ? label('conn.tokenStored') : '',
              onChange: (event) => props.setToken(event.target.value),
            }),
            h('span', { className: 'vb-muted' }, label('conn.tokenHint')),
            hasSecret
              ? h(CheckField, { checked: props.clearToken, onChange: (event) => props.setClearToken(event.target.checked) }, label('conn.clearToken'))
              : null,
          ),
          h(
            'div',
            { className: 'vb-actions' },
            h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: onSave }, busy ? label('saving') : label('save')),
            h(Button, { onClick: onCancel, disabled: Boolean(busy) }, label('cancel')),
          ),
        )
      }

      function SettingsPage() {
        const { state, error, reload } = useBridgeState()
        const { busy, error: actionError, invoke } = useAction(reload)
        const [draft, setDraft] = React.useState(null)
        const [editing, setEditing] = React.useState(null)
        const [token, setToken] = React.useState('')
        const [clearToken, setClearToken] = React.useState(false)
        const [diagnosis, setDiagnosis] = React.useState(null)
        const [installPrompt, setInstallPrompt] = React.useState(null)
        const [detectMessage, setDetectMessage] = React.useState('')
        const workspacePicker = ctx.get?.('uiWorkspace')
        React.useEffect(() => {
          if (!state || draft) return
          setDraft({
            source: { ...state.settings.source },
            pythonPath: state.settings.pythonPath,
            autoInstall: Boolean(state.settings.autoInstall),
            autoStart: [...(state.settings.autoStart || [])],
            defaultConnection: state.settings.defaultConnection || '',
            logToCiw: Boolean(state.settings.logToCiw),
            maxScripts: state.settings.maxScripts,
            cacheDir: state.settings.cacheDir || '',
            installSshExtra: state.settings.installSshExtra !== false,
          })
        }, [state, draft])
        if (!state || !draft) {
          return h('div', { className: 'vb-root vb-settings' }, styleElement, h('div', { className: 'vb-muted' }, error || label('loading')))
        }
        const setup = state.setup || {}
        const connections = state.connections || []
        const caches = state.caches || []
        const updateSource = (key) => (event) => setDraft({ ...draft, source: { ...draft.source, [key]: event.target.value } })
        const updateDraft = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })
        const toggleAutoStart = (connectionId) => (event) => {
          const next = new Set(draft.autoStart)
          if (event.target.checked) next.add(connectionId)
          else next.delete(connectionId)
          setDraft({ ...draft, autoStart: [...next] })
        }
        const saveSettings = async () => {
          await invoke('setup.configure', { settings: draft })
        }
        const saveSource = async () => {
          await invoke('setup.set_source', { source: draft.source })
        }
        const runInstall = async (confirm = false, recreate = false) => {
          const result = await invoke('setup.install', { confirm, recreate })
          if (result?.needsConfirmation) setInstallPrompt({ ...result, recreate })
          else setInstallPrompt(null)
        }
        const runUpdate = async (confirm = false) => {
          const result = await invoke('setup.update', { confirm })
          if (result?.needsConfirmation) setInstallPrompt(result)
          else setInstallPrompt(null)
        }
        const browseCacheDir = async () => {
          try {
            const chosen = await workspacePicker?.pickDirectory?.()
            if (chosen) setDraft({ ...draft, cacheDir: chosen })
          } catch (failure) {
            // The directory picker is optional; the text field remains usable.
          }
        }
        const detectShell = async (connection) => {
          const saved = await invoke('connection.save', { connection })
          if (!saved) return undefined
          const result = await invoke('connection.detect_shell', { connection: saved.id })
          if (result?.detection?.recommended) {
            setDetectMessage('')
            setEditing((current) =>
              current?.id === saved.id
                ? { ...current, detectedShell: result.detection.recommended, detectedAt: Date.now(), detectedScript: current.cadenceEnvScript }
                : current,
            )
          } else {
            setDetectMessage(result?.detection?.reason || 'shell detection found no Virtuoso environment')
          }
          return result
        }
        const beginNew = () => {
          setEditing({
            name: '',
            host: '',
            user: '',
            port: '',
            sshPort: 22,
            localPort: '',
            jumpHost: '',
            jumpUser: '',
            spectreHost: '',
            sshBackend: 'openssh',
            envShell: 'auto',
            cadenceEnvScript: '',
            identityFile: '',
            notes: '',
            enabled: true,
            kind: 'remote',
          })
          setToken('')
          setClearToken(false)
          setDetectMessage('')
        }
        const beginEdit = (connection) => {
          setEditing({ ...connection, port: connection.port ?? '', sshPort: connection.sshPort ?? 22, localPort: connection.localPort ?? '' })
          setToken('')
          setClearToken(false)
          setDetectMessage('')
        }
        const saveConnection = async () => {
          if (!editing) return
          const secret = token ? { daemonToken: token } : clearToken ? { daemonToken: null } : undefined
          const result = await invoke('connection.save', { connection: editing, secret })
          if (result) {
            setEditing(null)
            setToken('')
            setClearToken(false)
          }
        }
        const removeConnection = async (connection) => {
          if (!window.confirm(label('conn.deleteConfirm'))) return
          await invoke('connection.delete', { connection: connection.id })
          if (editing?.id === connection.id) setEditing(null)
        }
        const runDiagnosis = async () => {
          const result = await invoke('setup.diagnose', {})
          if (result?.diagnosis) setDiagnosis(result.diagnosis)
        }
        return h(
          'div',
          { className: 'vb-root vb-settings' },
          styleElement,
          h(
            'div',
            { className: 'vb-top' },
            h('div', null, h('div', { className: 'vb-title' }, label('settings.title')), h('div', { className: 'vb-muted' }, label('settings.intro'))),
            h(Button, { onClick: reload, disabled: Boolean(busy) }, label('refresh')),
          ),
          h(ErrorBanner, { message: error || actionError, onRetry: reload }),
          h(
            Section,
            {
              title: label('section.setup'),
              actions: h(
                'div',
                { className: 'vb-actions' },
                h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: () => runInstall(false, false) }, setup.installing ? label('setup.installing') : label('install')),
                h(Button, { disabled: Boolean(busy), onClick: () => runInstall(false, true) }, label('repair')),
                h(Button, { disabled: Boolean(busy), onClick: () => runUpdate(false) }, label('update')),
                h(Button, { disabled: Boolean(busy), onClick: runDiagnosis }, label('diagnose')),
              ),
            },
            h(
              'div',
              { className: 'vb-card' },
              h(
                'div',
                { className: 'vb-row vb-between vb-wrap' },
                h('span', { className: 'vb-strong' }, setup.installed ? label('setup.installed') : label('setup.notInstalled')),
                h('span', { className: 'vb-muted vb-ellipsis' }, setup.venv?.path || ''),
              ),
              h(
                'div',
                { className: 'vb-mono vb-muted' },
                `${label('setup.version')}: ${setup.venv?.package?.version || '—'} · ${label('setup.python')}: ${setup.python?.version || '—'} · ${label('setup.source')}: ${setup.source?.mode || '—'}`,
              ),
              setup.backends
                ? h(
                    'div',
                    { className: 'vb-muted' },
                    `${label('backends.openssh')}: ${setup.backends.openssh?.available ? setup.backends.openssh.version || setup.backends.openssh.path : label('backends.missing')} · ` +
                      `${label('backends.paramiko')}: ${setup.backends.paramiko?.installed ? setup.backends.paramiko.version || label('backends.installed') : label('backends.missing')}`,
                  )
                : null,
              setup.backends?.needsConfirmation
                ? h('div', { className: 'vb-error' }, label('backends.confirmMissing'))
                : null,
              installPrompt
                ? h(
                    'div',
                    { className: 'vb-warn' },
                    h('div', null, installPrompt.message || label('backends.confirmMissing')),
                    h(
                      'div',
                      { className: 'vb-actions' },
                      h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: () => runInstall(true, Boolean(installPrompt.recreate)) }, label('backends.installAnyway')),
                      h(Button, { disabled: Boolean(busy), onClick: () => setInstallPrompt(null) }, label('cancel')),
                    ),
                  )
                : null,
              setup.lastInstall?.installedAt
                ? h('div', { className: 'vb-muted' }, `${label('settings.installedAt')}: ${new Date(setup.lastInstall.installedAt).toLocaleString()} · ${setup.lastInstall.sourceInfo?.commit ? setup.lastInstall.sourceInfo.commit.slice(0, 12) : ''}`)
                : null,
              h(
                'div',
                { className: 'vb-grid' },
                h(
                  SelectField,
                  { label: label('setup.source'), value: draft.source.mode, onChange: updateSource('mode'), hint: label('setup.modeHint') },
                  h('option', { value: 'bundled' }, label('setup.mode.bundled')),
                  h('option', { value: 'local' }, label('setup.mode.local')),
                  h('option', { value: 'git' }, label('setup.mode.git')),
                ),
                h(TextField, { label: label('setup.pythonPath'), value: draft.pythonPath, onChange: updateDraft('pythonPath') }),
                draft.source.mode === 'local'
                  ? h(TextField, { label: label('setup.localPath'), value: draft.source.localRepoPath || '', onChange: updateSource('localRepoPath'), placeholder: 'C:\\path\\to\\virtuoso-bridge-lite' })
                  : null,
                draft.source.mode === 'git'
                  ? h(TextField, { label: label('setup.repoUrl'), value: draft.source.repoUrl || '', onChange: updateSource('repoUrl') })
                  : null,
                draft.source.mode === 'git'
                  ? h(TextField, { label: label('setup.gitRef'), value: draft.source.gitRef || '', onChange: updateSource('gitRef') })
                  : null,
              ),
              h(
                'div',
                { className: 'vb-actions' },
                h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: saveSource }, label('settings.sourceSave')),
                h(Button, { disabled: Boolean(busy), onClick: () => invoke('setup.refresh', {}) }, label('refresh')),
              ),
              setup.installLog?.length
                ? h(
                    'div',
                    { className: 'vb-field' },
                    h('span', { className: 'vb-label' }, label('setup.log')),
                    h('pre', { className: 'vb-pre' }, setup.installLog.slice(-25).map((line) => `${new Date(line.time).toLocaleTimeString()} [${line.level}] ${line.message}`).join('\n')),
                  )
                : h('div', { className: 'vb-muted' }, label('setup.emptyLog')),
              diagnosis
                ? h(
                    'div',
                    { className: 'vb-card flat' },
                    h('div', { className: 'vb-strong' }, `${label('settings.diagnostics')}: ${diagnosis.ok ? label('settings.diagnosticsOk') : label('settings.diagnosticsFail')}`),
                    diagnosis.checks.map((check) =>
                      h('div', { className: 'vb-row vb-between', key: check.name },
                        h('span', null, check.name),
                        h('span', { className: check.ok ? 'vb-muted' : 'vb-error' }, check.detail),
                      ),
                    ),
                  )
                : null,
            ),
          ),
          h(
            Section,
            {
              title: label('section.connections'),
              count: connections.length,
              actions: h(Button, { onClick: beginNew, disabled: Boolean(busy) }, label('conn.add')),
            },
            connections.length
              ? connections.map((connection) =>
                  h(
                    'div',
                    { className: 'vb-card', key: connection.id },
                    h(
                      'div',
                      { className: 'vb-row vb-between vb-wrap' },
                      h(
                        'div',
                        { className: 'vb-row vb-grow' },
                        h('span', { className: `vb-dot ${connection.runtime || 'stopped'}` }),
                        h('span', { className: 'vb-strong vb-ellipsis' }, connection.name),
                        connection.hasSecret ? h('span', { className: 'vb-chip' }, 'token') : null,
                        connection.id === state.settings.defaultConnection ? h('span', { className: 'vb-chip' }, label('conn.default')) : null,
                      ),
                      h(
                        'div',
                        { className: 'vb-actions' },
                        h(Button, { disabled: Boolean(busy), onClick: () => beginEdit(connection) }, label('edit')),
                        h(Button, { disabled: Boolean(busy), onClick: () => invoke('connection.test', { connection: connection.id }) }, label('test')),
                        h(Button, { tone: 'danger', disabled: Boolean(busy), onClick: () => removeConnection(connection) }, label('delete')),
                      ),
                    ),
                    h('div', { className: 'vb-mono vb-muted vb-ellipsis' }, `${connection.user ? `${connection.user}@` : ''}${connection.host}:${connection.port} · ${label('conn.sshPortShort')} ${connection.sshPort || 22} · ${connection.envShell || 'auto'}`),
                    h(CheckField, { checked: draft.autoStart.includes(connection.id), onChange: toggleAutoStart(connection.id) }, label('conn.autoStart')),
                  ),
                )
              : h('div', { className: 'vb-card flat vb-muted' }, label('settings.noConnections')),
            editing
              ? h(ConnectionEditor, {
                  key: editing.id || 'new',
                  draft: editing,
                  setDraft: setEditing,
                  onSave: saveConnection,
                  onCancel: () => setEditing(null),
                  busy,
                  hasSecret: Boolean(editing.hasSecret),
                  token,
                  setToken,
                  clearToken,
                  setClearToken,
                  onDetectShell: detectShell,
                  detectMessage,
                })
              : null,
          ),
          h(
            Section,
            { title: label('section.defaults') },
            h(
              'div',
              { className: 'vb-card' },
              h(
                SelectField,
                { label: label('settings.defaultConnection'), value: draft.defaultConnection, onChange: updateDraft('defaultConnection') },
                h('option', { value: '' }, label('none')),
                connections.map((connection) => h('option', { value: connection.id, key: connection.id }, connection.name)),
              ),
              h(TextField, { label: label('settings.maxScripts'), value: draft.maxScripts, onChange: updateDraft('maxScripts'), inputMode: 'numeric' }),
              h(
                'div',
                { className: 'vb-row vb-wrap' },
                h(TextField, {
                  label: label('setup.cacheDir'),
                  value: draft.cacheDir || '',
                  onChange: updateDraft('cacheDir'),
                  hint: label('setup.cacheDirHint'),
                  placeholder: state.cacheDir || state.dataDir || '',
                }),
                workspacePicker?.pickDirectory
                  ? h(Button, { disabled: Boolean(busy), onClick: browseCacheDir }, label('setup.browse'))
                  : null,
                h(Button, { disabled: Boolean(busy), onClick: () => setDraft({ ...draft, cacheDir: '' }) }, label('setup.cacheDirDefault')),
              ),
              h(CheckField, { checked: draft.autoInstall, onChange: (event) => setDraft({ ...draft, autoInstall: event.target.checked }) }, label('settings.autoInstall')),
              h(CheckField, { checked: draft.logToCiw, onChange: (event) => setDraft({ ...draft, logToCiw: event.target.checked }) }, label('settings.logToCiw')),
              h(CheckField, { checked: draft.installSshExtra !== false, onChange: (event) => setDraft({ ...draft, installSshExtra: event.target.checked }) }, label('backends.installExtra')),
              h('div', { className: 'vb-muted' }, label('settings.autoStartHint')),
              h(
                'div',
                { className: 'vb-actions' },
                h(Button, { tone: 'primary', disabled: Boolean(busy), onClick: saveSettings }, busy ? label('saving') : label('settings.settingsSave')),
              ),
            ),
          ),
          h(
            Section,
            { title: label('section.caches'), count: caches.length, actions: h(Button, { onClick: () => invoke('cache.refresh', {}) }, label('refresh')) },
            caches.length
              ? h(
                  'div',
                  { className: 'vb-card' },
                  caches.map((cache) =>
                    h(
                      'div',
                      { className: 'vb-row vb-between vb-wrap', key: cache.id },
                      h('div', { className: 'vb-grow' }, h('div', null, cache.label), h('div', { className: 'vb-mono vb-muted vb-ellipsis', title: cache.path }, cache.path)),
                      h(
                        'div',
                        { className: 'vb-row vb-gap6' },
                        h('span', { className: 'vb-muted' }, `${formatBytes(cache.bytes)}${cache.files ? ` · ${cache.files} ${label('caches.files')}` : ''}`),
                        cache.clearable ? h(Button, { disabled: Boolean(busy), onClick: () => invoke('cache.clear', { cache: cache.id }) }, label('clear')) : null,
                      ),
                    ),
                  ),
                )
              : h('div', { className: 'vb-card flat vb-muted' }, label('caches.empty')),
          ),
        )
      }

      function OpenButton() {
        return h(
          'button',
          {
            type: 'button',
            className: 'vb-open',
            title: label('open'),
            'aria-label': label('open'),
            onClick: () => {
              try {
                ctx.sidebarRight.openTab(KIND)
              } catch (error) {
                console.error('virtuoso-bridge: could not open the dashboard', error)
              }
            },
          },
          h(
            'svg',
            { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'M3 15c1.7 0 2-6 3.7-6s1.6 8 3.3 8 1.7-9 3.4-9 1.6 7 3.3 7H21', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }),
            h('circle', { cx: '21', cy: '15', r: '1.8', fill: 'currentColor' }),
          ),
        )
      }

      ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'virtuoso-bridge: locale')
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TYPE_ID,
            kind: KIND,
            priority: 'extension',
            keepMounted: true,
            title: () => label('tab.title'),
            guide: [
              {
                id: 'dashboard',
                order: 40,
                title: () => label('tab.title'),
                description: () => label('tab.description'),
              },
            ],
          }),
        'virtuoso-bridge: tab type',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID, locale: NS }, DashboardBody),
          ),
        'virtuoso-bridge: dashboard body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: SETTINGS_SECTION, order: 60, label: () => label('settings.title') },
              SettingsPage,
            ),
          ),
        'virtuoso-bridge: settings page',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register({ name: 'conversation.input.left', id: 'virtuoso-bridge', order: 20, locale: NS }, OpenButton),
          ),
        'virtuoso-bridge: composer opener',
      )
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply,
    }
  },
})
