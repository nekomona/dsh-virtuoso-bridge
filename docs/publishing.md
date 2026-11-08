# Virtuoso Bridge — publishing guide

**English** | [简体中文](publishing.zh-CN.md) · [README](../README.md) ·
[plugin guide](plugin-guide.md)

This guide is the operator checklist for making the plugin publicly available as
the GitHub repository `nekomona/dsh-virtuoso-bridge` and the npm package
`@nekomona/dsh-virtuoso-bridge`. It covers the one-time account setup, the
release workflow, and how to bump the pinned upstream submodule.

## 1. Prerequisites

- Node.js 20 or newer with npm (the toolchain the workflows use).
- An npm account that can own the `@nekomona` scope.
- A GitHub account or organization named `nekomona`.
- Git with submodule support; `virtuoso-bridge-lite/` is a git submodule, so a
  checkout that is not cloned recursively needs
  `git submodule update --init virtuoso-bridge-lite`.
- A DSH profile to test the published bundle against before announcing it.

## 2. GitHub repository setup

Create the public repository `nekomona/dsh-virtuoso-bridge` without a template,
README or license, so the first push is clean. Then, from an existing checkout:

```powershell
git remote add origin git@github.com:nekomona/dsh-virtuoso-bridge.git
git push -u origin main
```

The `virtuoso-bridge-lite` submodule points at a public upstream commit of
[virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite), so
GitHub needs no special access and no extra deploy key for it. `.gitmodules`
deliberately declares no `branch`, so the submodule stays at the exact commit
recorded in `virtuoso-bridge-lite.pin.json`; an upstream `main` update cannot
change the bundled source. The Actions runner checks the repository out with
`submodules: recursive`, so `virtuoso-bridge-lite/` is available to CI without
further steps.

Three workflows live in `.github/workflows/`:

- `ci.yml` — runs on pushes and pull requests: verifies the
  `virtuoso-bridge-lite/` pin against `virtuoso-bridge-lite.pin.json`, checks
  that `.gitmodules` configures no branch, runs the public-release guard
  (`scripts/check-no-private-data.mjs`), syntax-checks the JavaScript and Python
  sources, and asserts the packed npm tarball contents.
- `release.yml` — runs on a `v*` tag: verifies the pin, runs the guard, asserts
  that the tag matches `package.json`'s version, publishes to npm, and creates a
  GitHub Release with the packed tarball attached.
- `upstream-watch.yml` — runs weekly on a cron schedule and on manual dispatch:
  compares upstream `Arcadia-1/virtuoso-bridge-lite` `refs/heads/main` with the
  pinned commit and opens or updates a GitHub issue labelled `upstream` when they
  differ, so a stale pin is an alert rather than a surprise; when they are equal
  it exits quietly.

## 3. npm account and scope

The package is a scoped package, `@nekomona/dsh-virtuoso-bridge`. Create the npm
user `nekomona` (or an organization of that name), then sign in locally once:

```powershell
npm login
npm whoami
```

Scoped packages default to restricted visibility, so publishing must pass
`--access public`. The release workflow already does, and `package.json` keeps
`publishConfig.access` set to `public`. Enable two-factor authentication on the
account; if CI should not be interrupted by 2FA prompts, create an automation
token (section 4) rather than relying on a one-time password.

## 4. npm token

1. In npm, create a token: **Automation** (simplest for CI) or **Granular** with
   read/write access to `@nekomona/*`.
2. In GitHub, open the repository's **Settings → Secrets and variables →
   Actions** and add a repository secret named `NPM_TOKEN` whose value is that
   token.

`release.yml` reads `secrets.NPM_TOKEN`; when the secret is missing, a dedicated
check fails before publishing with an explicit message naming the secret instead
of a generic authentication error. Never commit the token, paste it into an
issue, or write it into `package.json` or `.npmrc` in the repository.

## 5. First release

1. Confirm that `package.json` has `"version": "1.0.0"`; the tag must match it
   exactly.
2. Commit the release state, then tag and push the tag:

   ```powershell
   git tag v1.0.0
   git push origin v1.0.0
   ```

Use `git push --follow-tags` instead when the commit is pushed at the same time.

The tag starts `release.yml`, which:

1. verifies the `virtuoso-bridge-lite/` gitlink against
   `virtuoso-bridge-lite.pin.json`;
2. runs `scripts/check-no-private-data.mjs`;
3. runs the syntax checks;
4. asserts that `v1.0.0` matches `package.json`'s `version`;
5. publishes `@nekomona/dsh-virtuoso-bridge` with `--access public`;
6. creates a GitHub Release for the tag with the packed tarball attached.

`npm pack` and `npm publish` run `scripts/prepare-vendor.mjs` automatically as
`prepack`, so the tarball never ships a missing or stale
`virtuoso-bridge-lite/` checkout.

Manual fallback when the workflow cannot run:

```powershell
npm login
npm publish --access public
```

`npm pack --dry-run` is the cheap way to inspect exactly what would be shipped
before doing that.

## 6. Subsequent releases

1. Bump `version` in `package.json` (semver).
2. Commit.
3. Tag `vX.Y.Z` and push the tag; the same workflow publishes and creates the
   GitHub Release.

npm rejects a version that already exists, so every release needs a new version
— never reuse a tag or version. If a bad release ships, use `npm deprecate` on
that exact version to warn users and point them at a fixed release.
`npm unpublish` is only available within npm's grace window and should be the
last resort, because it breaks anyone who already resolved that version.

## 7. Bumping the bundled upstream pin

`virtuoso-bridge-lite/` follows upstream virtuoso-bridge-lite at the exact
commit recorded in `virtuoso-bridge-lite.pin.json`. The pin is stable by
construction: `.gitmodules` deliberately declares no `branch`, so
`git submodule update` always checks out the recorded gitlink and an upstream
`main` update cannot silently change the bundled source. Never run
`git submodule update --remote` — it is the only command that would follow a
moving branch. To move the pin deliberately:

```powershell
git -C virtuoso-bridge-lite fetch origin
git -C virtuoso-bridge-lite checkout <sha>
```

Then set `commit` and `commitDate` in `virtuoso-bridge-lite.pin.json` to the
checked-out commit and commit the gitlink and the pin together:

```powershell
git add virtuoso-bridge-lite virtuoso-bridge-lite.pin.json
git commit -m "chore: bump virtuoso-bridge-lite to <sha>"
```

Tag the release as usual. CI fails when the `virtuoso-bridge-lite/` gitlink and
`virtuoso-bridge-lite.pin.json` disagree, so a half-updated pin cannot be
released.

## 8. What consumers get

The published npm tarball contains the packaged subset of
`virtuoso-bridge-lite/` that the plugin installs — `pyproject.toml`, `README.md`,
`AGENTS.md`, `LICENSE`, `mcp_server.py`, `src/**` and `skills/**` — plus
`virtuoso-bridge-lite.pin.json` and the plugin's own JavaScript, runtime
scripts, documentation and locale files. Installing the bundle through DSH
therefore needs neither git nor the submodule: the plugin creates its venv and
pip-installs the packaged source. A development checkout is different: it needs
`git submodule update --init virtuoso-bridge-lite`, and the plugin reports an
actionable error when `virtuoso-bridge-lite/` is missing.

## 9. Safety notes

- `scripts/check-no-private-data.mjs` runs in CI and in the release path and
  guards against private data leaking into the public repository or tarball.
- Do not commit SSH material (`~/.ssh`, private keys), npm or GitHub tokens,
  `.local-backup/` (the gitignored local backup directory), or anything copied
  from `%USERPROFILE%`.
- Connection profiles and daemon tokens are local plugin state; they must never
  be added to the repository.
- Keep the token only in the GitHub `NPM_TOKEN` secret and rotate it if it is
  ever exposed.
