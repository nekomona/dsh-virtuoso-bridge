# Virtuoso Bridge — DSH plugin guide

**English** | [简体中文](plugin-guide.zh-CN.md) · [README](../README.md)

This guide covers installation, the DSH surfaces, runtime behavior, agent tools,
troubleshooting, and development for the `dsh-virtuoso-bridge` plugin.

## 1. What the plugin is

The plugin wraps [virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite)
for DeepSeek Harness (DSH). It manages:

- an isolated Python virtual environment containing virtuoso-bridge-lite;
- SSH connections and host-key trust;
- persistent SSH tunnels and CIW-side daemons across conversations;
- fixed-port legacy daemons and automatic-session/instance discovery;
- batched Python jobs and direct access to the whole Python API;
- a left configuration page and a right runtime panel.

It is a DSH bundle with a Host half (`index.js`, `lib/`) and a Client half
(`client.js`). A per-runtime Python sidecar (`runtime/vb_sidecar.py`) holds the
actual virtuoso-bridge client. The plugin does not implement its own Maestro
runner, job store, dialog manager, history manager, or scheduler; those are the
upstream VBL/DSH facilities.

## 2. Requirements

- DeepSeek Harness 0.2.2-class release with Cordis 4.x.
- Node.js for the Host half (provided by DSH).
- Python 3 for the plugin venv.
- Network access to a Python package index for the first install.
- Optional but recommended: OpenSSH (`ssh`) on `PATH`. Without it, installation
  requires explicit confirmation and uses the bundled Paramiko backend.
- Reachable SSH host and a running Virtuoso CIW for actual SKILL work.

## 3. Install

The bundle is published as the public scoped package
**`@nekomona/dsh-virtuoso-bridge`**.

### From npm (recommended)

Ask the agent to install that bundle, or run the plugin manager’s
`install_bundle` with the package name:

> Install the DSH bundle `@nekomona/dsh-virtuoso-bridge`.

No submodule and no Python checkout is required. The tarball contains the
packaged subset of the upstream source the plugin installs
(`pyproject.toml`, `README.md`, `AGENTS.md`, `LICENSE`, `mcp_server.py`,
`src/**`, `skills/**`), so the plugin only creates its venv and pip-installs
that source.

### From a git checkout (development)

```powershell
git clone --recurse-submodules https://github.com/nekomona/dsh-virtuoso-bridge.git <plugin-directory>
```

`vendor/` is a git submodule pinned to upstream virtuoso-bridge-lite. If the
clone was made without `--recurse-submodules`, initialise it before installing:

```powershell
git submodule update --init vendor
```

Install the local bundle through DSH, or ask the agent:

> Install the plugin bundle at `<plugin-directory>`.

Reload the DSH page once after installation so the browser bundle is current.

Data lives under:

```text
%USERPROFILE%\.dsh\virtuoso-bridge\<profile>\
```

`<profile>` defaults to `default`; override with `$DSH_PROFILE`,
`config.dataDir`, or `VB_PLUGIN_DATA_DIR`.

## 4. First-run configuration

Open **Virtuoso Bridge 配置** from the left global panel list. The page opens on
**Server connections**. Environment, defaults, storage, and activity are folded
until needed.

### 4.1 Environment

The environment card provides:

- **Install** when the venv is missing;
- **Diagnose** when installed;
- a `⋯` menu with **Repair** and **Update**;
- a collapsed **Source and install log** area containing:
  - source mode (bundled source / local repo / git);
  - Python executable;
  - local repo path or git URL/ref as appropriate;
  - the `vendor.pin.json` pin (upstream commit, date, license) for the bundled
    source;
  - install log;
  - backend and documentation details.

Source selection and `pythonPath` are saved together. Install and update first
persist the visible source draft, so the chosen source is actually used.

### 4.2 Source modes

- **Bundled source** — default; installs the pinned `vendor/` git submodule
  (`1f186ab`, recorded in `vendor.pin.json`). No tool-repository network
  access; pip still needs its normal package index. A source install must have
  the submodule checked out: when `vendor/` is missing or uninitialised the
  install fails with an actionable error naming
  `git submodule update --init vendor` (and the pinned commit). npm users never
  hit that state, because the published tarball carries the packaged subset of
  `vendor/`.
- **Local development repo** — editable install from
  `source.localRepoPath`. Code changes apply on the next runtime start.
- **Git repository** — clone from `source.repoUrl` at `source.gitRef` into the
  profile data directory.

### 4.3 Connections

Each connection card shows:

- state and name;
- **Start/Stop**;
- **Edit**;
- **Test**;
- **Deploy daemon setup**;
- `⋯` for DSH auto-connect, instance discovery, and delete.

The connection editor keeps primary fields visible and folds advanced network
settings, host roles, shell/Cadence environment, credentials, and workdir
sub-instances. Editing scrolls the editor into view.

Advanced connection fields include jump host, SSH backend, SSH proxy, identity
file, role overrides (`daemonHost`, `deployHost`, `guiHost`, `spectreHost`),
remote scratch root, client id, notes, and sub-instances.

### 4.4 Credentials

Daemon tokens are stored through the DSH credentials service, not in the
connection JSON or logs. The token field is write-only; the UI shows whether a
token is stored and can clear it.

## 5. Daemon deployment

**Deploy daemon setup** prepares/uploads the generated account bootstrap. It
does not start a tunnel, start/connect a daemon, or load SKILL. After it
succeeds, copy/load the returned line in the intended idle CIW:

```skill
load("/path/to/virtuoso_setup.il")
```

### Fixed-port mode

The connection selects a remote port (or derives one from the SSH user). The
CIW-side setup starts the daemon on that endpoint.

### Automatic sessions

Set `autoSessions` or use workdir sub-instances. The plugin discovers registered
daemons and selects one by port/workdir. Each sub-instance has its own VBL
profile/sidecar and appears as a separate runtime card.

### Conflict handling

If the remote generated bundle differs from the current bundle, normal
deployment does **not** overwrite it. The panel reports:

- the new/current package version when available;
- the existing daemon version when available, otherwise `version unknown`;
- the backend conflict details.

Only an explicit red **Overwrite** button authorizes replacement. The old
bundle is retained as a backup. Shared setups configured through
`daemonSetup` / install-daemon are read-only to clients.

After an overwrite, load the newly returned setup line in the CIW.

## 6. Runtime lifecycle

Runtime states:

| State | Meaning |
| --- | --- |
| `stopped` | no managed runtime |
| `starting` | tunnel/sidecar starting |
| `connecting` | sidecar connecting/deploying |
| `waiting` | tunnel up, daemon not answering |
| `running` | daemon responding |
| `error` | start/health/runtime failure |
| `needs-trust` | unknown SSH host key awaiting user confirmation |

The runtime panel shows connection state, daemon/health summary, remote project
working directory, and error details. The Host health loop checks status every
20 seconds and inspects X11 dialogs when the daemon is not answering.

### Popup/blocked CIW

When a modal dialog blocks the daemon:

- status includes the dialog title;
- the panel shows a warning;
- the hint tells the user to click/answer the dialog in Virtuoso, then refresh;
- it does **not** ask the user to reinstall or redeploy the daemon.

For a daemon that was previously healthy but stops answering, the panel shows a
daemon-lost reason instead of the initial setup hint.

## 7. Right runtime panel

The right tab is fixed to **Virtuoso Bridge**. In a narrow tab, DSH handles
label clipping/hiding.

Contents:

- **Environment**: shown only when the environment is not ready; provides an
  **Open settings** prompt.
- **Server connections**: all connections with Start/Stop, status, and a details
  disclosure.
- **Agent activity**: current session's agent pinned at top and highlighted.
  Each agent expands/collapses its own history. Running tools stay visible.
- **Connection pills**: on the same line as **Last used**, each server the agent
  has connected to appears as a pill. An inactive server >10 minutes is gray;
  >30 minutes is omitted from the pills only. The agent row remains.
- **Storage**: one-line size/free-space summary. The full path/size/clear list is
  on the configuration page.

Double-click an agent row to open that DSH session in the main view. Single
click toggles its history.

### Composer button

The composer button uses the project VB mark and a status dot:

- green: connected;
- yellow: waiting/blocked;
- red: error;
- breathing green: an operation for that session is running.

There is no extra text. The button is absent when the session has no active
runtime.

## 8. Agent tools

### `virtuoso_bridge_runtime`

Actions include:

- `status`, `list`
- `start`, `stop`, `restart`
- `ping`
- `deploy_daemon`
- `instances`, `select_instance`
- `detect_shell`
- `host_key`, `trust_host`
- `save_connection`, `delete_connection`, `connections`

Examples:

```text
virtuoso_bridge_runtime action=status
virtuoso_bridge_runtime action=start connection=lab
virtuoso_bridge_runtime action=deploy_daemon connection=lab
virtuoso_bridge_runtime action=select_instance connection=lab port=65123
```

`status` includes only active/recent agents; it reports project cwd, daemon
state, dialog state, setup hint (only before first readiness), and errors.

### `virtuoso_bridge_api`

Describes and calls any public VBL target:

```text
virtuoso_bridge_api action=describe target=client
virtuoso_bridge_api action=describe target=client.schematic
virtuoso_bridge_api action=call target=client.schematic method=open_window ...
```

Targets include `client`, `client.schematic`, `client.layout`, `client.library`,
`client.symbol`, `client.maestro`, `client.sos`, `client.dialogs`,
`client.requests`, and `spectre`.

### `virtuoso_bridge_script`

Runs Python inside the plugin venv with the connected client available:

```python
result = {"windows": client.schematic.list_windows()}
```

Behavior:

- `run` creates an action/job and returns `Running` with a job id if not finished.
- `status` returns the full job snapshot.
- `list` lists recent jobs.
- `cancel` cancels a job.
- A required one-line `description` labels the call and the Chat tool card.
- The Chat tool card shows `Script: <description>`, code, and result and is
  always expandable.

### `virtuoso_bridge_setup`

- `status`, `preflight`
- `install`, `update`
- `diagnose`
- `configure`, `set_source`
- `caches`, `clear_cache`

## 9. Activity, storage, and diagnostics

- Global **Activity** is on the configuration page, folded by default.
- **Storage** is on the configuration page with cache labels, paths, byte sizes,
  file counts, free space, and per-item Clear controls.
- The right panel keeps only a storage summary.
- Runtime diagnostics include stage, SSH backend, host-key probe, tunnel/daemon
  state, error details, and dialog inspection.

## 10. Security

- Host-key trust is explicit; changed keys are conflicts, never silently
  replaced.
- Daemon tokens are held by DSH credentials and passed through the sidecar env.
- The dashboard bootstraps a per-process token over a loopback-only endpoint.
- Remote setup paths are private and ownership-checked by VBL.
- Shared/install-daemon setups cannot be replaced by clients.

## 11. Troubleshooting

### Daemon does not answer

1. Check whether a modal dialog is blocking the CIW. The panel/status reports
   its title; click/answer it.
2. If the setup script was never loaded, use the printed `load("...")` line.
3. If the daemon was previously running, inspect the CIW for a busy command,
   crashed session, or changed port.
4. Do not blindly reinstall; the panel exposes the actual health reason.

### Deployment conflict

1. Read the conflict card; compare the shown versions.
2. Use **Overwrite** only when the existing generated bundle is stale/corrupt
   or the profile changed.
3. After overwrite, load the new setup line in the intended CIW.

### `Failed to fetch` in DSH

The client retries once after clearing a stale dashboard base/token, applies
request timeouts, and prefers the current page origin. Refresh the DSH page if
the dashboard server restarted.

### History shows loading

History content is fetched on expansion. A local timeout clears the loading
state; when the fetch succeeds, the code/result appears. If the backend is
unreachable, the failure is reported instead of hanging forever.

### SSH/OpenSSH issues

- Verify `ssh` on `PATH` or explicitly choose Paramiko.
- For jump hosts and non-standard ports, check the connection editor’s advanced
  network/role fields.
- Host-key conflicts require an explicit trust decision.

## 12. Development

```powershell
node --check index.js
node --check client.js
node --check lib/manager.js
node --check lib/tools.js
python -m py_compile runtime/vb_sidecar.py
node --check runtime/vb_deploy.py
node scripts/prepare-vendor.mjs --verify-only
node scripts/check-no-private-data.mjs
npm pack --dry-run
```

`prepare-vendor.mjs --verify-only` confirms that the `vendor/` gitlink matches
`vendor.pin.json` (the same check the release workflow runs, and the full script
runs automatically as `prepack`); `check-no-private-data.mjs` is the
public-release guard for tokens, local paths and backup directories. `npm pack
--dry-run` shows the packaged tarball contents without publishing.

Client changes require a DSH page refresh; Host changes require reloading the
plugin. The plugin’s philosophy is to wrap existing VBL/DSH APIs rather than add
parallel infrastructure.

## 13. Limitations

- The plugin cannot load SKILL into a running CIW automatically.
- No Cadence or Spectre license/hardware is included.
- First install downloads Python dependencies.
- UI rendering depends on the DSH version and theme.
- Live SKILL/GUI behavior depends on the installed VBL version and CIW state.

## 14. License

MIT. `vendor/` is the upstream virtuoso-bridge-lite git submodule and retains
upstream’s MIT license and attribution; the pinned commit, date and license are
recorded in `vendor.pin.json`.
