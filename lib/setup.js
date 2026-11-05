/** Isolated Python environment, vendored/local/git source selection, install. */
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  delay,
  dirExistsSync,
  directoryUsage,
  ensureDir,
  fileExistsSync,
  findExecutable,
  formatBytes,
  freeDisk,
  isWindows,
  probePython,
  readJson,
  readTail,
  runProcess,
  writeJson,
} from './util.js'

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

export class SetupManager {
  constructor({ pluginDir, dataDir, store, log }) {
    this.pluginDir = pluginDir
    this.dataDir = dataDir
    this.store = store
    this.log = log
    this.installing = false
    this.installStartedAt = 0
    this.installLog = []
    this.lastInstall = undefined
    this.installPromise = undefined
    this.probeCache = undefined
    this.probeAt = 0
    this.usageCache = undefined
    this.usageAt = 0
  }

  get venvDir() {
    return path.join(this.dataDir, 'venv')
  }

  get cacheDir() {
    const configured = String(this.store?.snapshot?.().cacheDir ?? '').trim()
    return configured ? path.resolve(configured) : this.dataDir
  }

  get venvPython() {
    return isWindows
      ? path.join(this.venvDir, 'Scripts', 'python.exe')
      : path.join(this.venvDir, 'bin', 'python')
  }

  get sourcesDir() {
    return path.join(this.cacheDir, 'sources')
  }

  get instructionsDir() {
    return path.join(this.dataDir, 'instructions')
  }

  get instructionsMetaFile() {
    return path.join(this.instructionsDir, 'INSTRUCTIONS.json')
  }

  get installMetaFile() {
    return path.join(this.dataDir, 'install.json')
  }

  get probeScript() {
    return path.join(this.pluginDir, 'runtime', 'vb_probe.py')
  }

  get venvExists() {
    return fileExistsSync(this.venvPython)
  }

  invalidate() {
    this.baseCache = undefined
    this.probeCache = undefined
    this.usageCache = undefined
    this.backendCache = undefined
    this.probeAt = 0
    this.backendAt = 0
  }

  addLog(message, level = 'info') {    const line = { time: Date.now(), level, message: String(message) }
    this.installLog.push(line)
    if (this.installLog.length > 400) this.installLog.splice(0, this.installLog.length - 400)
    this.log?.(level, message)
    const file = path.join(this.dataDir, 'logs', 'install.log')
    fsp.mkdir(path.dirname(file), { recursive: true })
      .then(() => fsp.appendFile(file, `${new Date(line.time).toISOString()} [${level}] ${line.message}\n`, 'utf8'))
      .catch(() => {})
  }

  async basePython() {
    if (this.baseCache && Date.now() - this.baseAt < 60_000) return this.baseCache
    const configured = this.store.snapshot().pythonPath
    const candidates = [configured, process.env.VB_PYTHON, 'python', 'python3'].filter(Boolean)
    const results = []
    for (const candidate of candidates) {
      const probe = await probePython(candidate)
      if (probe) results.push(probe)
      if (probe?.ok && probe.major >= 3 && probe.minor >= 9) {
        this.baseCache = { ...probe, candidates: results }
        this.baseAt = Date.now()
        return this.baseCache
      }
    }
    const first = results[0]
    const fallback = { ...(first ?? { ok: false, detail: 'no Python interpreter found', candidates: results }), candidates: results }
    this.baseCache = fallback
    this.baseAt = Date.now()
    return fallback
  }

  async resolveSource(prepare = false) {
    const settings = this.store.snapshot()
    const source = settings.source
    if (source.mode === 'local') {
      const dir = path.resolve(source.localRepoPath || '.')
      if (!fileExistsSync(path.join(dir, 'pyproject.toml'))) {
        throw new Error(`local repo has no pyproject.toml: ${dir}`)
      }
      return { mode: 'local', dir, editable: true, detail: `local repo ${dir}` }
    }
    if (source.mode === 'git') {
      const dir = path.join(this.sourcesDir, `git-${stableHash(`${source.repoUrl}#${source.gitRef}`)}`)
      if (prepare) {
        await ensureDir(this.sourcesDir)
        if (!fileExistsSync(path.join(dir, 'pyproject.toml'))) {
          await this.gitCheckout(source, dir)
        } else {
          await this.gitUpdate(source, dir)
        }
      }
      return { mode: 'git', dir, editable: false, detail: `${source.repoUrl}@${source.gitRef}` }
    }
    const dir = path.join(this.pluginDir, 'vendor')
    if (!fileExistsSync(path.join(dir, 'pyproject.toml'))) {
      throw new Error(`bundled snapshot is missing pyproject.toml under ${dir}`)
    }
    return { mode: 'bundled', dir, editable: false, detail: 'bundled snapshot' }
  }

  async gitCheckout(source, dir) {
    const git = (await findExecutable('git')) ?? 'git'
    await ensureDir(path.dirname(dir))
    this.addLog(`cloning ${source.repoUrl} (${source.gitRef})`)
    let result = await runProcess(
      git,
      ['clone', '--depth', '1', '--branch', source.gitRef, source.repoUrl, dir],
      { timeoutMs: 5 * 60 * 1000, onStdout: (text) => this.addLog(text.trim()), onStderr: (text) => this.addLog(text.trim(), 'warn') },
    )
    if (!result.ok) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      this.addLog(`branch clone failed; retrying full clone (${result.stderr.trim().slice(-500)})`, 'warn')
      result = await runProcess(git, ['clone', '--depth', '1', source.repoUrl, dir], {
        timeoutMs: 5 * 60 * 1000,
        onStdout: (text) => this.addLog(text.trim()),
        onStderr: (text) => this.addLog(text.trim(), 'warn'),
      })
      if (result.ok) {
        await runProcess(git, ['-C', dir, 'checkout', source.gitRef], { timeoutMs: 60_000 })
      }
    }
    if (!result.ok) throw new Error(`git clone failed: ${result.stderr.trim().slice(-2000) || result.stdout.slice(-2000)}`)
  }

  async gitUpdate(source, dir) {
    const git = (await findExecutable('git')) ?? 'git'
    const inside = await runProcess(git, ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 15_000 })
    if (!inside.ok) {
      await fsp.rm(dir, { recursive: true, force: true })
      await this.gitCheckout(source, dir)
      return
    }
    this.addLog(`updating ${dir} to ${source.gitRef}`)
    const fetch = await runProcess(git, ['-C', dir, 'fetch', '--depth', '1', 'origin', source.gitRef], {
      timeoutMs: 5 * 60 * 1000,
      onStderr: (text) => this.addLog(text.trim(), 'warn'),
    })
    const checkout = fetch.ok
      ? await runProcess(git, ['-C', dir, 'checkout', '-f', 'FETCH_HEAD'], { timeoutMs: 60_000 })
      : fetch
    if (!checkout.ok) {
      await fsp.rm(dir, { recursive: true, force: true })
      await this.gitCheckout(source, dir)
    }
  }

  async gitInfo(dir) {
    const git = (await findExecutable('git')) ?? 'git'
    const top = await runProcess(git, ['-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 })
    if (!top.ok || path.resolve(top.stdout.trim()) !== path.resolve(dir)) {
      // The bundled snapshot lives inside the plugin checkout; do not report
      // the plugin repository as the tool's own source/commit.
      return { available: false }
    }
    const head = await runProcess(git, ['-C', dir, 'rev-parse', 'HEAD'], { timeoutMs: 15_000 })
    const describe = await runProcess(git, ['-C', dir, 'describe', '--tags', '--always'], { timeoutMs: 15_000 })
    const status = await runProcess(git, ['-C', dir, 'status', '--porcelain'], { timeoutMs: 15_000 })
    return {
      available: head.ok,
      commit: head.ok ? head.stdout.trim() : undefined,
      describe: describe.ok ? describe.stdout.trim() : undefined,
      dirty: status.ok ? status.stdout.trim().length > 0 : undefined,
    }
  }

  async sourceInfo(source) {
    const info = { mode: source.mode, dir: source.dir, detail: source.detail, exists: dirExistsSync(source.dir) }
    if (!info.exists) return info
    const vendor = await readJson(path.join(source.dir, 'VENDOR.json'), undefined)
    if (vendor) {
      info.snapshot = vendor
      info.version = vendor.version
      info.commit = vendor.commit
    }
    const git = await this.gitInfo(source.dir)
    if (git.available) {
      info.commit = git.commit
      info.describe = git.describe
      info.dirty = git.dirty
    }
    try {
      const pyproject = await fsp.readFile(path.join(source.dir, 'pyproject.toml'), 'utf8')
      const match = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)
      if (match && !info.version) info.version = match[1]
    } catch {
      // optional
    }
    return info
  }

  async probeVenv(force = false) {
    if (!force && this.probeCache && Date.now() - this.probeAt < 5_000) return this.probeCache
    this.probeAt = Date.now()
    if (!this.venvExists) {
      this.probeCache = { ok: false, reason: 'venv is not created', python: this.venvPython }
      return this.probeCache
    }
    const result = await runProcess(this.venvPython, [this.probeScript], {
      cwd: this.pluginDir,
      timeoutMs: 30_000,
    })
    let parsed
    try {
      parsed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? '')
    } catch {
      parsed = undefined
    }
    this.probeCache = {
      ok: Boolean(result.ok && parsed && !parsed.error && parsed.package),
      reason: parsed?.error ?? (result.ok ? undefined : result.stderr.trim().slice(-1500) || 'probe failed'),
      python: this.venvPython,
      pythonVersion: parsed?.python,
      package: parsed?.package,
      isVenv: parsed?.isVenv,
      executable: parsed?.executable,
      detail: parsed,
    }
    return this.probeCache
  }

  async backendStatus(force = false) {
    if (!force && this.backendCache && Date.now() - this.backendAt < 30_000) return this.backendCache
    this.backendAt = Date.now()
    const ssh = await findExecutable('ssh')
    let opensshVersion
    if (ssh) {
      const version = await runProcess(ssh, ['-V'], { timeoutMs: 8_000 })
      opensshVersion = `${version.stderr}${version.stdout}`.trim().split(/\r?\n/)[0]
    }
    const probe = await this.probeVenv()
    const paramiko = probe.detail?.paramiko
    const socks = probe.detail?.PySocks ?? probe.detail?.pysocks ?? probe.detail?.socks
    this.backendCache = {
      openssh: {
        available: Boolean(ssh),
        path: ssh,
        version: opensshVersion,
        detail: ssh ? opensshVersion : 'ssh is not on PATH',
      },
      paramiko: {
        installed: Boolean(paramiko?.ok),
        version: paramiko?.version,
        error: paramiko?.error,
        socks: Boolean(socks?.ok),
        socksVersion: socks?.version,
      },
      supported: [ssh ? 'openssh' : undefined, paramiko?.ok ? 'paramiko' : undefined].filter(Boolean),
      preferred: ssh ? 'openssh' : paramiko?.ok ? 'paramiko' : undefined,
      needsConfirmation: !ssh,
      extra: await this.sshExtraSpecs(),
    }
    return this.backendCache
  }

  async preflight() {
    const base = await this.basePython()
    const backends = await this.backendStatus(true)
    let source
    try {
      source = await this.sourceInfo(await this.resolveSource(false))
    } catch (error) {
      source = { mode: this.store.snapshot().source.mode, error: String(error), exists: false }
    }
    const probe = await this.probeVenv()
    return {
      python: { ok: base.ok, version: base.version, executable: base.executable },
      source,
      installed: probe.ok,
      venv: { path: this.venvDir, exists: this.venvExists, python: this.venvPython },
      backends,
      cacheDir: this.cacheDir,
      needsConfirmation: backends.needsConfirmation,
      message: backends.needsConfirmation
        ? 'OpenSSH (ssh) was not found on PATH. Installation will add the Paramiko SSH backend; the OpenSSH backend will be unavailable until ssh is installed.'
        : undefined,
    }
  }

  async sshExtraSpecs() {
    try {
      const resolved = await this.resolveSource(false)
      const text = await fsp.readFile(path.join(resolved.dir, 'pyproject.toml'), 'utf8').catch(() => '')
      const section = /\[project\.optional-dependencies\]([\s\S]*?)(?=\n\[|$)/.exec(text)
      const line = section && /(?:^|\n)\s*ssh\s*=\s*\[([\s\S]*?)\]/.exec(section[1])
      if (line) {
        const specs = [...line[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
        if (specs.length) return specs
      }
    } catch {
      // fall through to the bridge's documented extra
    }
    return ['paramiko>=3.5', 'PySocks>=1.7.1']
  }

  async installInstructions(sourceDir) {
    const source = sourceDir ?? (await this.resolveSource(false)).dir
    const sourceSkills = path.join(source, 'skills')
    if (!dirExistsSync(sourceSkills)) {
      throw new Error(`the selected bridge source has no skills directory: ${sourceSkills}`)
    }
    const temp = path.join(this.dataDir, `.instructions-${process.pid}-${Date.now()}`)
    await fsp.rm(temp, { recursive: true, force: true })
    await ensureDir(temp)
    try {
      await fsp.cp(sourceSkills, path.join(temp, 'skills'), { recursive: true })
      for (const name of ['README.md', 'AGENTS.md', 'VENDOR.json']) {
        const from = path.join(source, name)
        if (fileExistsSync(from)) await fsp.copyFile(from, path.join(temp, name))
      }
      const snapshot = await readJson(path.join(source, 'VENDOR.json'), undefined)
      await writeJson(path.join(temp, 'INSTRUCTIONS.json'), {
        sourceDir: source,
        version: snapshot?.version,
        commit: snapshot?.commit,
        installedAt: Date.now(),
      })
      await fsp.rm(this.instructionsDir, { recursive: true, force: true })
      await fsp.rename(temp, this.instructionsDir)
    } catch (error) {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    this.log?.('info', `installed bridge documentation and skills at ${this.instructionsDir}`)
    return this.instructionsInfo()
  }

  async ensureInstructions() {
    if (dirExistsSync(path.join(this.instructionsDir, 'skills'))) {
      return this.instructionsInfo()
    }
    return this.installInstructions()
  }

  async instructionsInfo() {
    const meta = await readJson(this.instructionsMetaFile, undefined)
    const skillsRoot = path.join(this.instructionsDir, 'skills')
    const skills = []
    if (dirExistsSync(skillsRoot)) {
      for (const entry of await fsp.readdir(skillsRoot, { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory()) continue
        const file = path.join(skillsRoot, entry.name, 'SKILL.md')
        if (!fileExistsSync(file)) continue
        const head = await fsp.readFile(file, 'utf8').catch(() => '')
        const name = (/^name:\s*(.+)$/m.exec(head)?.[1]?.trim() || entry.name).replace(/^["']|["']$/g, '')
        const description = (/^description:\s*(.+)$/m.exec(head)?.[1]?.trim() || '').replace(/^["']|["']$/g, '')
        skills.push({ name, path: file, description })
      }
    }
    return {
      dir: this.instructionsDir,
      exists: dirExistsSync(this.instructionsDir),
      sourceDir: meta?.sourceDir,
      version: meta?.version,
      commit: meta?.commit,
      skills,
    }
  }

  async skillDefinition() {
    const info = (await this.ensureInstructions().catch(() => undefined)) ?? (await this.instructionsInfo())
    if (!info?.dir) return undefined
    const lines = [
      '# virtuoso-bridge installed instructions',
      '',
      `The virtuoso-bridge documentation and skills are installed by this plugin at \`${info.dir}\`.`,
      info.exists
        ? 'Read the matching VBL skill and references before issuing bridge commands; do not guess `virtuoso-bridge` CLI flags.'
        : 'The documentation copy is not present yet. Run virtuoso_bridge_setup action "install"/"update", then read the installed SKILL.md and references here.',
      '',
      'Installed skills:',
      ...info.skills.map((skill) => `- **${skill.name}** — ${skill.description || 'Virtuoso Bridge skill'}\n  \`${skill.path}\``),
      '',
      `Bridge agent guide: \`${path.join(info.dir, 'AGENTS.md')}\``,
      `Bridge README: \`${path.join(info.dir, 'README.md')}\``,
      `Connection/deployment reference: \`${path.join(info.dir, 'skills', 'virtuoso', 'references', 'connection.md')}\``,
      '',
      'Use the plugin agent tools (`virtuoso_bridge_*`) for live operations. Use `virtuoso_bridge_api` to inspect the installed Python API; use `virtuoso_bridge_script` for batched Python.',
    ]
    return {
      name: 'virtuoso-bridge',
      description: 'Installed virtuoso-bridge-lite SKILL, connection, deployment, layout, Maestro and Spectre documentation.',
      whenToUse: 'Use before any Cadence Virtuoso, Spectre, layout, Maestro, netlist or optimizer work through this plugin; read the matching installed SKILL.md and references instead of guessing CLI commands.',
      content: lines.join('\n'),
      resourceBase: { kind: 'directory', path: info.dir },
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    }
  }

  async status() {
    const settings = this.store.snapshot()
    const base = await this.basePython()
    let source
    try {
      const resolved = await this.resolveSource(false)
      source = await this.sourceInfo(resolved)
    } catch (error) {
      source = { mode: settings.source.mode, error: String(error), exists: false }
    }
    const probe = await this.probeVenv()
    if (this.lastInstall === undefined) {
      const stored = await readJson(this.installMetaFile, undefined)
      this.lastInstall = stored ?? null
    }
    if (!this.installLog.length) {
      this.installLog = await readInstallLog(path.join(this.dataDir, 'logs', 'install.log'))
    }
    return {
      installed: probe.ok,
      venv: {
        path: this.venvDir,
        exists: this.venvExists,
        python: this.venvPython,
        version: probe.pythonVersion,
        package: probe.package,
        reason: probe.reason,
      },
      python: {
        configured: settings.pythonPath,
        command: base.command,
        executable: base.executable,
        version: base.version,
        ok: base.ok,
        detail: base.detail,
        candidates: (base.candidates ?? []).map((item) => ({ executable: item.executable, version: item.version, ok: item.ok })),
      },
      source,
      instructions: await this.instructionsInfo(),
      backends: await this.backendStatus(),
      installing: this.installing,
      installStartedAt: this.installStartedAt || undefined,
      lastInstall: this.lastInstall,
      installLog: this.installLog.slice(-80),
      dataDir: this.dataDir,
      cacheDir: this.cacheDir,
      pluginDir: this.pluginDir,
      git: Boolean(await findExecutable('git')),
      disk: await freeDisk(this.cacheDir),
    }
  }

  async install(options = {}) {
    if (this.installPromise) return this.installPromise
    const promise = this.#install(options).finally(() => {
      this.installPromise = undefined
    })
    this.installPromise = promise
    return promise
  }

  async #install(options) {
    this.installing = true
    this.installStartedAt = Date.now()
    this.installLog = []
    this.addLog('starting virtuoso-bridge installation')
    const started = Date.now()
    try {
      const base = await this.basePython()
      if (!base.ok || base.major < 3 || (base.major === 3 && base.minor < 9)) {
        throw new Error(`Python >= 3.9 is required; found ${base.version ?? base.detail ?? 'nothing'}`)
      }
      this.addLog(`base Python: ${base.executable} (${base.version})`)
      if (options.recreate && dirExistsSync(this.venvDir)) {
        this.addLog('removing existing venv')
        await fsp.rm(this.venvDir, { recursive: true, force: true })
      }
      if (!this.venvExists) {
        await ensureDir(path.dirname(this.venvDir))
        this.addLog(`creating venv at ${this.venvDir}`)
        const venv = await runProcess(base.executable, ['-m', 'venv', this.venvDir], {
          timeoutMs: 180_000,
          onStderr: (text) => this.addLog(text.trim(), 'warn'),
        })
        if (!venv.ok) throw new Error(`venv creation failed: ${venv.stderr.trim().slice(-2000)}`)
      }
      const source = await this.resolveSource(true)
      this.addLog(`installing from ${source.detail}`)
      const cacheEnv = {
        ...process.env,
        PIP_CACHE_DIR: path.join(this.cacheDir, 'pip'),
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PYTHONUNBUFFERED: '1',
      }
      // Build isolation re-downloads setuptools on every repair.  Keep the
      // build backend in the venv and install the project without isolation.
      const prepare = await runProcess(
        this.venvPython,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-warn-script-location', 'setuptools>=64', 'wheel'],
        {
          env: cacheEnv,
          timeoutMs: 180_000,
          maxOutput: 80_000,
          onStderr: (text) => {
            const line = text.trim()
            if (line) this.addLog(line, 'warn')
          },
        },
      )
      if (!prepare.ok) {
        this.addLog('could not seed the build backend; falling back to build isolation', 'warn')
      }
      const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-warn-script-location']
      if (prepare.ok) args.push('--no-build-isolation')
      if (source.mode === 'local' && options.editable !== false) args.push('-e')
      args.push(source.dir)
      const env = cacheEnv
      const result = await runProcess(this.venvPython, args, {
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
        maxOutput: 400_000,
        onStdout: (text) => {
          for (const line of text.split(/\r?\n/)) {
            if (line.trim()) this.addLog(line.trim())
          }
        },
        onStderr: (text) => {
          for (const line of text.split(/\r?\n/)) {
            if (line.trim()) this.addLog(line.trim(), /error|failed/i.test(line) ? 'error' : 'warn')
          }
        },
      })
      if (!result.ok) throw new Error(`pip install failed:\n${result.stderr.trim().slice(-4000) || result.stdout.trim().slice(-4000)}`)
      if (source.mode === 'bundled') {
        // setuptools may write an in-tree build/ and egg-info next to the
        // snapshot; keep the linked plugin checkout clean.
        await fsp.rm(path.join(source.dir, 'build'), { recursive: true, force: true }).catch(() => {})
        for (const parent of [source.dir, path.join(source.dir, 'src')]) {
          for (const entry of await fsp.readdir(parent).catch(() => [])) {
            if (entry.endsWith('.egg-info')) {
              await fsp.rm(path.join(parent, entry), { recursive: true, force: true }).catch(() => {})
            }
          }
        }
      }
      const warnings = []
      if (this.store.snapshot().installSshExtra !== false) {
        const specs = await this.sshExtraSpecs()
        this.addLog(`installing the SSH backend extra by default: ${specs.join(', ')}`)
        const extra = await runProcess(
          this.venvPython,
          ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--no-warn-script-location', ...specs],
          {
            env,
            timeoutMs: 10 * 60 * 1000,
            maxOutput: 200_000,
            onStdout: (text) => {
              for (const line of text.split(/\r?\n/)) if (line.trim()) this.addLog(line.trim())
            },
            onStderr: (text) => {
              for (const line of text.split(/\r?\n/)) if (line.trim()) this.addLog(line.trim(), 'warn')
            },
          },
        )
        if (!extra.ok) {
          const warning = `Paramiko SSH extra failed to install: ${(extra.stderr || extra.stdout).trim().slice(-1500)}`
          warnings.push(warning)
          this.addLog(warning, 'warn')
        }
      } else {
        this.addLog('SSH backend extra installation is disabled in settings', 'warn')
      }
      this.addLog('verifying the isolated environment')
      const probe = await this.probeVenv(true)
      if (!probe.ok) throw new Error(`installed package cannot be imported: ${probe.reason}`)
      let instructions
      try {
        instructions = await this.installInstructions(source.dir)
      } catch (error) {
        const warning = `bridge documentation copy failed: ${error instanceof Error ? error.message : String(error)}`
        warnings.push(warning)
        this.addLog(warning, 'warn')
      }
      const sourceInfo = await this.sourceInfo(source)
      const meta = {
        installedAt: Date.now(),
        durationMs: Date.now() - started,
        source,
        sourceInfo,
        python: base.version,
        venvPython: this.venvPython,
        package: probe.package,
        editable: source.mode === 'local' && options.editable !== false,
        warnings,
        backends: await this.backendStatus(true),
        instructions,
      }
      await writeJson(this.installMetaFile, meta)
      this.lastInstall = meta
      this.addLog(`installed virtuoso-bridge ${probe.package?.version ?? ''} in ${formatDuration(Date.now() - started)}`)
      if (warnings.length) this.addLog(`installation finished with ${warnings.length} warning(s)`, 'warn')
      return { ok: true, ...meta }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.addLog(message, 'error')
      return { ok: false, error: message, log: this.installLog.slice(-80) }
    } finally {
      this.installing = false
      this.installStartedAt = 0
      this.probeCache = undefined
    }
  }

  async diagnose() {
    const checks = []
    const base = await this.basePython()
    checks.push({ name: 'python', ok: base.ok && base.major >= 3 && base.minor >= 9, detail: `${base.executable ?? '(not found)'} ${base.version ?? ''}` })
    checks.push({ name: 'git', ok: Boolean(await findExecutable('git')), detail: (await findExecutable('git')) ?? 'git not found on PATH' })
    let source
    try {
      source = await this.resolveSource(false)
      checks.push({ name: 'source', ok: true, detail: `${source.mode}: ${source.dir}` })
    } catch (error) {
      checks.push({ name: 'source', ok: false, detail: String(error) })
    }
    const probe = await this.probeVenv()
    checks.push({ name: 'venv', ok: this.venvExists, detail: this.venvPython })
    checks.push({
      name: 'package',
      ok: probe.ok,
      detail: probe.ok ? `virtuoso-bridge ${probe.package?.version}` : probe.reason ?? 'not installed',
    })
    checks.push({ name: 'data-dir', ok: dirExistsSync(this.dataDir), detail: this.dataDir })
    const backends = await this.backendStatus(true)
    checks.push({
      name: 'ssh-backends',
      ok: backends.supported.length > 0,
      detail: `openssh: ${backends.openssh.available ? backends.openssh.version || backends.openssh.path : 'missing'} · paramiko: ${backends.paramiko.installed ? backends.paramiko.version || 'installed' : 'missing'}`,
    })
    checks.push({
      name: 'paramiko-extra',
      ok: backends.paramiko.installed,
      detail: backends.paramiko.installed
        ? `paramiko ${backends.paramiko.version ?? ''}${backends.paramiko.socks ? ' + PySocks' : ' (PySocks missing)'}`
        : 'not installed',
    })
    checks.push({ name: 'cache-dir', ok: dirExistsSync(this.cacheDir), detail: this.cacheDir })
    return { ok: checks.every((check) => check.ok), checks, status: await this.status() }
  }

  async caches(force = false) {
    if (!force && this.usageCache && Date.now() - this.usageAt < 20_000) return this.usageCache
    this.usageAt = Date.now()
    const entries = [
      { id: 'venv', label: 'Python virtualenv', path: this.venvDir },
      { id: 'pip', label: 'pip wheel cache', path: path.join(this.cacheDir, 'pip') },
      { id: 'sources', label: 'Git checkouts', path: this.sourcesDir },
      { id: 'jobs', label: 'Script jobs', path: path.join(this.cacheDir, 'jobs') },
      { id: 'results', label: 'Large results', path: path.join(this.cacheDir, 'results') },
      { id: 'logs', label: 'Logs', path: path.join(this.dataDir, 'logs') },
      { id: 'vendor', label: 'Bundled snapshot', path: path.join(this.pluginDir, 'vendor') },
    ]
    const output = []
    for (const entry of entries) {
      const usage = await directoryUsage(entry.path)
      output.push({
        ...entry,
        bytes: usage.bytes,
        files: usage.files,
        truncated: usage.truncated,
        exists: dirExistsSync(entry.path),
        clearable: ['pip', 'sources', 'jobs', 'results', 'logs'].includes(entry.id),
      })
    }
    const disk = await freeDisk(this.cacheDir)
    this.usageCache = { entries: output, disk, dataDir: this.dataDir, cacheDir: this.cacheDir, generatedAt: Date.now() }
    return this.usageCache
  }

  async clearCache(cacheId) {
    const allowed = {
      pip: path.join(this.cacheDir, 'pip'),
      sources: this.sourcesDir,
      jobs: path.join(this.cacheDir, 'jobs'),
      results: path.join(this.cacheDir, 'results'),
      logs: path.join(this.dataDir, 'logs'),
    }
    const target = allowed[cacheId]
    if (!target) throw new Error(`cache ${cacheId} is not clearable`)
    await fsp.rm(target, { recursive: true, force: true })
    await ensureDir(target)
    this.usageCache = undefined
    return { cleared: cacheId, path: target }
  }

  async installLogTail(maxBytes = 40_000) {
    return readTail(path.join(this.dataDir, 'logs', 'install.log'), maxBytes)
  }
}

function stableHash(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash).toString(36)
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60_000)} min`
}

async function readInstallLog(file) {
  const text = await readTail(file, 60_000)
  const lines = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = /^(\S+)\s+\[(\w+)\]\s(.*)$/.exec(line)
    if (!match) {
      lines.push({ time: Date.now(), level: 'info', message: line })
      continue
    }
    const time = Date.parse(match[1])
    lines.push({ time: Number.isFinite(time) ? time : Date.now(), level: match[2], message: match[3] })
  }
  return lines.slice(-80)
}

export { formatDuration }
