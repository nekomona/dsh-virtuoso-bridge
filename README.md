# Virtuoso Bridge — DeepSeek Harness plugin

A persistent DSH profile plugin for [virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite).
It turns the bridge's background SSH tunnel and CIW-side daemon into **managed
runtimes** that survive conversations, exposes the whole Python API to the
agent, runs batched Python inside an isolated venv, and projects runtime state
into a right-sidebar **Bridge runtime** panel while keeping configuration in a
full-page **Virtuoso Bridge** panel in the left sidebar.

The plugin bundles a source snapshot of virtuoso-bridge-lite, so it works
without a separate checkout, and can instead follow a local development repo or
clone a git repository at a chosen ref. The bundled snapshot tracks upstream
commit `1f186ab` (2026-11-03), including automatic session/instance discovery,
instance-bound daemon authentication, shared daemon setup, split host roles,
the expanded layout/bbox/group APIs, Maestro engine configuration and the newer
Spectre presets.

## What it provides

| Concern | Surface |
| --- | --- |
| Tool source and isolated Python environment | Host setup manager, left **Virtuoso Bridge** config page, `virtuoso_bridge_setup` |
| Server connections and credentials | Left **Virtuoso Bridge** config page, `virtuoso_bridge_runtime`, DSH credentials service |
| Managed tunnels / daemons across conversations | Process-wide runtime manager, Host service |
| Fixed-port or automatic-session daemon discovery and selection | Config page, `instances` / `select_instance` tool actions |
| Connection status, daemon/instance state, attached agents, caches, ongoing actions | Right-sidebar **Bridge runtime** panel |
| Every public virtuoso-bridge-lite function | `virtuoso_bridge_api` (`describe` / `call`) |
| Batched Python in the venv | `virtuoso_bridge_script` (jobs, status, cancel) |

## Install

The plugin is a DSH bundle package. From a git checkout of this directory:

```powershell
git clone <your-plugin-repository> <plugin-directory>
```

Then install the local bundle through DSH, for example by asking the agent:

> Install the plugin bundle at `<plugin-directory>`.

which runs the plugin manager's `install_bundle` on that directory. The bundle
patch inserts the Host row `virtuoso-bridge` and the browser half is discovered
through `dsh.client`. The client bootstraps its panel token through a
loopback-only endpoint, so a page loaded before installation can recover; a
reload still picks up the newest browser bundle.

The plugin targets the profile it is installed into. Runtimes, settings, the
venv and script jobs live under:

```
%USERPROFILE%\.dsh\virtuoso-bridge\<profile>\
```

`<profile>` is `$DSH_PROFILE` when the Host process exports it (otherwise the
folder is `default`). Override with `config.dataDir` or
`VB_PLUGIN_DATA_DIR`.

## First setup

Open the **Virtuoso Bridge** waveform icon in the left sidebar's global panel
list (beside Plugins and Automation tasks); it selects the full-page
configuration panel. You can also ask the agent to run
`virtuoso_bridge_setup` with action `status`. Choose a source:

* **Bundled snapshot** (default) — installs `vendor/` from this plugin. No
  network access to the tool repository; pip still needs its normal package
  index on the first install.
* **Local development repo** — installs editable from `source.localRepoPath`
  (for example `C:\src\virtuoso-bridge-lite`). Code edits are picked up on
  the next runtime start; reinstall with *Repair* if packaging metadata
  changes.
* **Git repository** — clones `source.repoUrl` at `source.gitRef` into the
  plugin data directory, then installs it. *Update* fetches the ref again.

Press **Install**. The plugin creates a private venv, installs the tool and its
dependencies, installs the **SSH extra** (`paramiko` + `PySocks`) by default,
and verifies `import virtuoso_bridge` with `runtime/vb_probe.py`. If OpenSSH
(`ssh`) is not on `PATH`, installation stops and asks for confirmation before
continuing with the Paramiko backend only. The same operation is available as
`virtuoso_bridge_setup` action `install` (or `update`), with `confirm: true` for
the Paramiko-only case; action `preflight` reports supported backends and the
extra definition.

Python 3.9+ and `git` must be on `PATH`. The Python executable is configurable
as `source.pythonPath` / `settings.pythonPath`.

## Connections and credentials

Add a connection in the left **Virtuoso Bridge** configuration panel or with
`virtuoso_bridge_runtime` action `save_connection`:

```json
{
  "name": "lab-virtuoso-auto",
  "host": "virtuoso01.example.com",
  "user": "designer",
  "autoSessions": true,
  "instancePort": null,
  "remoteWorkDir": "/projects/example",
  "daemonSetup": "/opt/virtuoso-bridge/v1/virtuoso_setup.il",
  "sshPort": 22,
  "jumpHost": "",
  "sshBackend": "openssh",
  "spectreHost": "",
  "envShell": "auto",
  "cadenceEnvScript": "/site/cadence/setup.csh",
  "identityFile": "C:\\Users\\me\\.ssh\\id_ed25519"
}
```

In fixed mode, leaving `port` blank derives the bridge's stable per-user daemon
port from the SSH user name (SHA-1, range 65000–65499), matching
`virtuoso_bridge.basic.bridge._default_remote_port`. In automatic mode
(`autoSessions: true`), `port` is unused; the daemon uses an OS-assigned port.
`remoteWorkDir` is an absolute filter, `daemonSetup` optionally names a shared
`virtuoso_setup.il` installed by `virtuoso-bridge install-daemon`, and
`instancePort` selects one discovered instance. Use the configuration page's
**Discover instances** action or `virtuoso_bridge_runtime` action `instances`,
then `select_instance` or **Use this instance** when more than one matches.

`envShell: "auto"` runs the configured Cadence environment script under both
csh and sh and chooses the one that exposes `virtuoso`; the result is cached per
connection and can also be refreshed with `detect_shell` in the configuration
panel.

Advanced connections can set `daemonHost`, `deployHost`, `guiHost`,
`remoteScratchRoot`, `clientId`, `sshMaxSessions` and a Paramiko
`sshProxy` (`socks5://host:port`). These map to the upstream split-host,
private-scratch and proxy settings. Host-key preflight and the SSH test target
the primary `host`; trust additional role-host keys through `ssh`/known_hosts
before using a split topology.

For a site-wide bootstrap, install the upstream shared bundle on the Linux
Cadence host with `virtuoso-bridge install-daemon <versioned-directory>` and set
`daemonSetup` to the printed `virtuoso_setup.il`. All automatic-session clients
share that setup; changing a client environment cannot retroactively update a
running CIW.

On the first connection the plugin reads the offered host keys and stops in
the **needs-trust** state with their SHA-256 fingerprints. It does not trust or
add a key until the user confirms it (the runtime-panel button, or a `trust_host`
tool call made only after the user confirms the fingerprint). Trust writes that
single key to `~/.ssh/known_hosts`. A changed key is reported as a conflict and
never silently replaced. Failed starts report the stage, SSH/daemon output,
traceback and host-key probe result in the runtime panel and tool error.

Auth uses the system `ssh` configuration (agent, keys, `~/.ssh/config`) or the
optional paramiko backend. `identityFile` writes a per-connection SSH config
that includes the user's own config. The optional **daemon token** is stored
through the DSH `credentials` service as a grant record; it is write-only in
the UI and is never returned by the panels, tools or logs. Local
connections (`localhost`, `127.0.0.1`, `::1`) skip SSH and use the local
bridge token file exactly like `virtuoso-bridge` local mode.

The plugin never copies the user's `~/.virtuoso-bridge/.env`: the Python client
is isolated from it with an empty runtime env file, so a saved connection is
authoritative for that runtime.

## Runtime lifecycle

`virtuoso_bridge_runtime` action `start` starts the managed SSH tunnel,
deploys the remote setup and connects the sidecar. A runtime reports:

* **starting / connecting** — sidecar and tunnel are being established.
* **needs-trust** — a first connection offered an unknown SSH host key. The
  runtime is intentionally not started; confirm the fingerprint in the runtime
  panel or with `trust_host`, then start again. When a live agent/session is
  available the plugin also raises the same confirmation as a question in the
  main conversation, so the right sidebar does not have to be open.
* **waiting** — the tunnel is up but the Virtuoso CIW has not loaded the bridge
  setup yet. The runtime panel shows the exact `load("...")` command; run it in
  the CIW, then the health poll flips the runtime to **running**.
* **running** — `execute_skill("1+1")` answered through the daemon.
* **stopped / error** — no sidecar, or the last start failed.

Runtime snapshots carry a separate `daemon` object and `connectionStatus`:
`ready`, `no-response`, `auth-failed`, `unreachable` or `unknown`. Startup
records it from the connect handshake, and **Test** queries it again when a
runtime sidecar is available. The runtime panel shows it as its own chip next to
the connection state.

Automatic-session runtimes also expose the selected `instance` (`port`, Virtuoso
`pid`, `work_dir`, user) and the upstream daemon-build compatibility message.
Discovery is read-only until a selection is stored; a missing selection or
multiple matching instances fails with the available list rather than silently
picking one.

Runtimes are process-wide, so they survive conversation changes, forks and
subagent sessions. They stop when the plugin is disabled/unloaded or DSH exits,
or explicitly with action `stop`. An orphaned tunnel left by a crashed earlier
process is detected from the virtuoso-bridge state file and can be stopped from
the runtime panel/tool (`orphans`, `stop_orphan`).

Health polling runs every 20 seconds and deliberately does not write to the
CIW (`log_to_ciw=False` unless `settings.logToCiw` is enabled).

## Local cache directory

**Virtuoso Bridge → Runtime defaults** in the left configuration page has an
editable cache directory (text field plus a directory picker when the host
provides one). It holds pip wheels, git checkouts, script jobs and large
results. The venv, `settings.json` and plugin logs stay in the data directory;
changing the cache path does not move existing files, and the runtime panel
immediately shows the new paths. Leave it blank to use the data directory.

## Agent tools

All tools are registered on the Host and are available in every conversation of
the profile.

### `virtuoso_bridge_runtime`

`status`, `list`, `start`, `stop`, `restart`, `ping`, `connections`,
`save_connection`, `delete_connection`, `test_connection`, `instances`,
`select_instance`, `detect_shell`, `host_key`, `trust_host`, `orphans`,
`stop_orphan`.

`status`/`list` return a compact projection: setup readiness, connection
endpoints, runtime state, daemon/instance state, attached agents and running
actions. Verbose install logs, source/venv debug paths, tunnel internals and full
tracebacks stay in the UI, which keeps the full state. `status` with
`waitMs` waits until an in-flight start settles (or the budget expires) instead
of returning immediately while the runtime is still starting. `instances`
performs read-only automatic-session discovery; `select_instance` stores the
chosen port on the connection before a restart. `test_connection` uses the same
SSH backend as the bridge — Paramiko sessions never launch `ssh.exe` — and
includes the daemon status when a runtime is already reachable.

### `virtuoso_bridge_api`

`describe` returns classes, targets, methods, Python signatures, parameter
kinds and docstrings. `call` invokes one method on:

```
client
client.schematic   client.layout    client.library   client.symbol
client.maestro     client.sos       client.dialogs   client.requests
spectre
```

The dynamic `describe` follows the installed bridge, so the newer layout
bbox/group builders, Maestro engine/X-preset operations, unified search and
dialog helpers appear without plugin-specific wrappers.

Example:

```json
{"action": "call", "target": "client", "method": "execute_skill",
 "args": ["1+1"], "timeoutSec": 60}
```

Rich arguments use explicit markers:
`{"$type":"path","value":"/tmp/x.il"}` and
`{"$type":"bytes","data":"<base64>"}`. Dataclass results (for example
`VirtuosoResult`, `SimulationResult`) are converted to JSON. Results over
1.5M characters are written to `<dataDir>/results/` and returned as a preview
and path.

### `virtuoso_bridge_script`

Runs a Python file or inline source in a **new venv process**, never in the
sidecar, so a bad batch cannot break the connection. The script gets:

```python
import virtuoso_bridge as vb
client = connect()          # reuse the running tunnel/daemon
emit({"progress": 0.5})     # structured progress
result = {"done": True}     # persisted as result.json
```

Jobs have ids, status, incremental stdout/stderr, a hard timeout and
cancellation. Jobs started by one conversation can be polled from another; the
last 40 job directories are indexed when the plugin starts.

### `virtuoso_bridge_setup`

`status`, `preflight`, `install`, `update`, `diagnose`, `configure`,
`set_source`, `caches`, `clear_cache`. `status` and `preflight` return only the
installed/source/venv/backend facts needed to decide the next step; the full
install log and source snapshot remain in the configuration page. `diagnose` is
the explicit plugin-debugging action. If OpenSSH is
missing, `install` returns a confirmation request; retry with `confirm: true`
to continue with Paramiko only.

## Panels

The plugin has two complementary surfaces, following the stock panel pattern:

* **Virtuoso Bridge** in the left sidebar's global panel list opens the
  full-page configuration view: setup source and backends, fixed or automatic
  session settings, connection editing, instance discovery/selection, runtime
  defaults, cache directory and diagnostics. This replaces the former DSH
  Settings page. Styling follows the stock management pages (page header,
  constrained content column, section cards, shared buttons and theme tokens).
* **Bridge runtime** is a right-sidebar tab. It shows connection/runtime,
  daemon and selected-instance state, attached agents, caches, ongoing/recent
  operations and activity. It has a **Configure** button that selects the left
  configuration page.

The composer shows a waveform toggle only while this Session has an active
bridge runtime attached (running, waiting, starting or connecting) via a tool
call or a panel start. Clicking it opens or closes the **Bridge runtime** tab
for the current Session. A Session with no active bridge keeps the composer
clean.

Both surfaces read the same same-origin endpoint at `/__dsh/virtuoso-bridge`
with an SSE stream. The Host registers the route through
`ctx.inject(['webServer'])`, so a cold boot where the webserver activates after
feature plugins still exposes it. The browser half bootstraps
`{ token, origin, basePath }` from a loopback-only `/bootstrap`, tries the
injected origin first and then the page's own origin, and retries after a 404
or a stale token. The endpoint requires the per-process token or a local
same-origin request (`Sec-Fetch-Site` / matching loopback `Origin` / `Host`);
cross-site requests are rejected. Binding the Web server to a non-loopback
address still widens exposure of the whole DSH UI, so keep the default
loopback bind. Reload the page after upgrading the plugin so the browser uses
the current bundle.

## Files

```
index.js              Host plugin: manager wiring, effect lifecycle
client.js             Browser plugin: config page, runtime panel, sidebar icon
cordis.patch.yml      Bundle patch (Host row)
lib/store.js          settings.json, connections, validation
lib/setup.js          python/venv/source selection, install, diagnostics, caches
lib/sidecar.js        line-JSON sidecar process client
lib/manager.js        runtimes, sidecars, script jobs, actions, state, orphans
lib/http.js           token-protected state/action/SSE transport
lib/tools.js          four agent tools + prompt section
runtime/vb_sidecar.py one JSON-RPC process per runtime (owns the Python client)
runtime/vb_script.py  isolated batch script runner
runtime/vb_instances.py read-only automatic-session discovery
runtime/vb_probe.py   venv/package probe
runtime/vb_stop_profile.py  orphan tunnel cleanup
vendor/               virtuoso-bridge-lite source snapshot + VENDOR.json
```

The sidecar keeps the original stdout duplicated for protocol frames and
redirects Python `print()` output to stderr, so the bridge's progress messages
can never corrupt a JSON response.

## Verification performed

* `install_bundle` activated the Host row and registered all four tools. The
  Client slot tree contains the `virtuoso-bridge` sidebar panel entry, the
  `virtuoso-bridge` configuration page, the runtime tab type with its
  `sidebar.right.pane.tab` body, and the composer toggle. The DSH
  `settings.section` registration was removed; configuration lives only in the
  left full-page panel.
* The isolated venv was created and `virtuoso_bridge` imported from it; the
  bundled snapshot (`1f186ab`), a local development checkout (editable) and a
  git clone (local `file://` repository at `main`) were each installed and
  probed. The installed package exposes `instance_discovery`, `daemon_setup`
  and the Maestro engine module.
* A local runtime started into `waiting`, kept the new
  `autoSessions`/`instance` fields, exposed its Session attachment, and stopped
  cleanly.
* `instances` discovery ran on both fixed and `autoSessions` connections. It
  returned an empty registry for an old-daemon host instead of failing, and the
  automatic mode reported `autoSessions: true`.
* `deploy_daemon` prepared a bootstrap without connecting and returned a usable
  `load("...")` line. With a per-connection `remoteScratchRoot` it resolved that
  root and returned the setup path underneath it; with only a global
  `defaultRemoteScratchRoot` the deployed `.../daemon/virtuoso_setup.il` path
  followed that root as well, and the setting was reverted afterwards. The
  shared-setup branch reports the managed path without attempting replacement.
* Connections with two workdir sub-instances created two distinct runtime
  ids/profiles (`rt_<connection>__<sub>`) and started independently; deleting the
  base connection removed both runtimes. Local automatic discovery is Linux-only,
  so that path was exercised only up to its expected discovery error.
* The composer toggle component returns nothing until a runtime is attached to
  the current Session; starting a runtime attached it through `runtime.agents`.
  The full-page configuration component and the right runtime component render
  their initial states without throwing in the client module harness. Panel
  visual styling was checked against the stock management-page structure
  (header, constrained column, section cards), not pixel-by-pixel.
* Setup installed `skills/`, `README.md` and `AGENTS.md` under
  `<dataDir>/instructions`, and the DSH skill catalog listed the new
  `virtuoso-bridge` entry. Loading that skill returned the installed resource
  base and every `SKILL.md` path. The system prompt names the same absolute
  instructions directory and tells the agent not to guess bridge CLI flags.
  The installed `references/agent-workflows.md` documents only existing VBL
  entry points (`MaestroJobManager`, `client.dialogs`, `x11.dismiss_window`,
  `save_setup`, history and job-policy APIs).
* Starting a remote runtime predeploys/verifies the existing
  `x11_dismiss_dialog.py` helper in the client-scoped scratch directory; a
  missing helper no longer depends on a later ad-hoc upload.
* `virtuoso_bridge_api` described the client object graph (including the
  `client.layout` create/modify/export operations with signatures) and executed a
  module function through the sidecar. `virtuoso_bridge_script` returned
  `Success` plus a result, `Running` plus a job id, and a failed-run summary with
  no path/status/code-preview fields. A required one-line description labeled
  each call, and the Web tool-view slot registered an always-expandable
  `Script: <description>` code card with the Python source and result.
* The runtime panel groups completed operations and API labels under each
  connected agent, uses the DSH session title when available, keeps running
  operations visible with an animated marker, and exposes agent → history →
  Code/Result folds. The configuration page owns the global action/log history.
* The panel endpoint was exercised with a token, a same-origin request
  without a token and a rejected cross-site request; its state, action,
  bootstrap and index-injection paths returned the expected payloads. A
  Host-side self-test fetches `/health` and `/state` from `webServer.getOrigin()`
  and is part of `virtuoso_bridge_setup` action `diagnose`. The panel route is
  registered through `ctx.inject(['webServer'])`, so it is installed after a
  cold-boot webserver activation rather than only on the hot install path.
* The daemon-port hash was compared with `_default_remote_port` for several
  SSH user names; a blank port resolved to the same value that helper computes.
  The SSH extra (`paramiko` + `PySocks`) was installed into the plugin venv and
  OpenSSH was detected as well; a missing-OpenSSH confirmation result was
  exercised with a fake preflight.
* Host-key discovery was exercised against a reachable SSH endpoint (keyscan
  fallback and Paramiko fallback), fingerprint computation matched the
  endpoint's published SHA-256, and a temporary known_hosts trust/evaluate cycle
  passed. A start against an unknown host reached **needs-trust** and displayed
  the fingerprint instead of starting. A deliberately unresolvable remote
  connection produced a structured failure report with stage, host, SSH port,
  backend and host-key probe details.
* The cache directory was changed through `setup.configure`; pip/source/job/
  result paths followed it and the setting reverted to the data directory.
  `detect_shell` returned its no-environment-script reason without connecting.
  `virtuoso_bridge_setup` status/preflight and `virtuoso_bridge_runtime`
  status/list returned the compact projection (no install log, source snapshot,
  cache/logs/jobs or tracebacks); a start failure reported only its stage,
  endpoint, backend and host-key fingerprints.
* The runtime panel **Clear history** action removed completed operations through
  the token-protected endpoint (2 removed, 0 running). The activity log has its
  own clear action. Section folding and viewport scrolling are implemented in
  the client source. A `status` call with `waitMs` while a start was in flight
  waited through the start and returned the resulting error state instead of an
  immediate "starting" snapshot; the earlier behavior returned immediately for
  `starting`/`connecting` runtimes, and it now waits for the start promise or the
  state to settle.
* A Paramiko test/login against a jump-host connection succeeded through VBL's
  Paramiko backend. A process monitor observed only hidden `ssh -G`
  configuration lookups (window handle `0`, empty title), not a visible command
  window. Paramiko host-key probing through the jump host also returned both the
  target and jump fingerprints.
* A start against a pre-existing remote daemon reached the daemon identity
  check and reported `daemon: auth-failed` (that daemon predated token auth),
  while the SSH login and host-key verification succeeded.
* The host-key question flow was exercised with a temporary HOME and a fake
  answer: the question was raised, "Trust and start" selected, the key appended
  to the temporary known_hosts, and the start continued to the next setup stage.
* Syntax checks: `node --check` for every JavaScript file and `py_compile` for
  every runtime script.

Not verified here: a healthy daemon on Cadence hardware, the real Web question
card's pixel rendering (the Host question/answer flow was exercised with a fake
answerer), shell auto-detection against a real csh/sh site script, and
pixel-level browser rendering of the fold/scroll controls. Refresh the Web page
once after installation so the served client bundle is current.

## Limitations

* A runtime can start the tunnel and deploy setup, but **cannot load SKILL into
  a running Virtuoso CIW**. The user must run the printed `load("...")` once;
  the runtime then becomes `running` automatically.
* No Cadence/Virtuoso or Spectre hardware is exercised by this plugin's own
  tests. Live behaviour depends on the installed virtuoso-bridge version, SSH
  configuration and the CIW state.
* Python dependencies are downloaded on first install. Reinstall/Repair after
  changing the Python interpreter or the local repo.
* Browser UI was verified through DSH's client registration and source checks;
  pixel-level rendering depends on the host theme.

## License

The plugin is provided under the MIT License. The bundled
`vendor/` snapshot retains virtuoso-bridge-lite's MIT `LICENSE` and attribution.
