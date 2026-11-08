# Virtuoso Bridge — 发布指南

[English](publishing.md) | **简体中文** · [README](../README.zh-CN.md) ·
[插件指南](plugin-guide.zh-CN.md)

本指南是让插件对外公开的操作清单，目标是 GitHub 仓库
`nekomona/dsh-virtuoso-bridge` 与 npm 包 `@nekomona/dsh-virtuoso-bridge`。
内容包括一次性的账号配置、发布工作流，以及如何更新内置上游 submodule 的固定版本。

## 1. 前置条件

- Node.js 20 或更高版本，并带有 npm（与工作流使用的工具链一致）。
- 可拥有 `@nekomona` scope 的 npm 账号。
- 名为 `nekomona` 的 GitHub 账号或组织。
- 支持 submodule 的 git；`virtuoso-bridge-lite/` 是 git submodule，因此非递归 clone 的
  checkout 需要执行 `git submodule update --init virtuoso-bridge-lite`。
- 一个用于在对外公布前验证发布 bundle 的 DSH profile。

## 2. GitHub 仓库设置

创建公开仓库 `nekomona/dsh-virtuoso-bridge`，不要使用模板，也不要自动生成 README
或许可证，以便首次推送干净。然后在已有的 checkout 中执行：

```powershell
git remote add origin git@github.com:nekomona/dsh-virtuoso-bridge.git
git push -u origin main
```

`virtuoso-bridge-lite` submodule 指向
[virtuoso-bridge-lite](https://github.com/Arcadia-1/virtuoso-bridge-lite) 的公开上游
提交，因此 GitHub 侧不需要特殊权限，也不需要额外的 deploy key。`.gitmodules` 不声明
`branch`，submodule 因此固定在 `virtuoso-bridge-lite.pin.json` 记录的精确提交上，上游
`main` 更新不会改变内置源码。Actions runner 使用 `submodules: recursive` 检出仓库，
CI 无需额外步骤即可获得 `virtuoso-bridge-lite/`。

两个工作流位于 `.github/workflows/`：

- `ci.yml`：在 push 和 pull request 时运行，校验 `virtuoso-bridge-lite/` gitlink 与
  `virtuoso-bridge-lite.pin.json` 一致、`.gitmodules` 未配置 branch，运行公开发布检查
  （`scripts/check-no-private-data.mjs`）以及 JavaScript/Python 语法检查，并校验打包
  后的 npm tarball 内容。
- `release.yml`：在 `v*` tag 时运行，校验固定版本、运行发布检查、确认 tag 与
  `package.json` 的 version 一致、发布到 npm，并创建附带打包 tarball 的 GitHub Release。

## 3. npm 账号与 scope

该包是 scoped 包 `@nekomona/dsh-virtuoso-bridge`。创建 npm 用户 `nekomona`
（或同名组织），并在本地登录一次：

```powershell
npm login
npm whoami
```

scoped 包默认为受限（非公开）可见性，因此发布时必须带 `--access public`。发布工作流
已经这样做了，`package.json` 也保持 `publishConfig.access` 为 `public`。建议在账号上
启用双因素认证；如果不想让 CI 被 2FA 提示打断，请创建自动化 token（第 4 节），
而不是依赖一次性密码。

## 4. npm token

1. 在 npm 中创建 token：**Automation**（CI 最简单）或对 `@nekomona/*` 具有读写
   权限的 **Granular** token。
2. 在 GitHub 仓库中打开 **Settings → Secrets and variables → Actions**，添加名为
   `NPM_TOKEN` 的仓库 secret，值为该 token。

`release.yml` 读取 `secrets.NPM_TOKEN`；缺少该 secret 时，会在发布前由专门的检查
步骤以明确指出该 secret 的消息失败，而不是笼统的认证错误。不要把 token 提交到仓库、
粘贴到 issue，或写入仓库内的 `package.json` / `.npmrc`。

## 5. 首次发布

1. 确认 `package.json` 中为 `"version": "0.1.0"`；tag 必须与之完全一致。
2. 提交发布状态，然后创建并推送 tag：

   ```powershell
   git tag v0.1.0
   git push origin v0.1.0
   ```

如果同时推送提交，也可以使用 `git push --follow-tags`。

该 tag 会触发 `release.yml`，它依次：

1. 校验 `virtuoso-bridge-lite/` gitlink 与 `virtuoso-bridge-lite.pin.json` 一致；
2. 运行 `scripts/check-no-private-data.mjs`；
3. 运行语法检查；
4. 确认 `v0.1.0` 与 `package.json` 的 `version` 一致；
5. 以 `--access public` 发布 `@nekomona/dsh-virtuoso-bridge`；
6. 为该 tag 创建 GitHub Release，并附带打包好的 tarball。

`npm pack` 和 `npm publish` 会通过 `prepack` 自动运行
`scripts/prepare-vendor.mjs`，因此 tarball 不会包含缺失或过期的
`virtuoso-bridge-lite/` checkout。

工作流不可用时的手动方式：

```powershell
npm login
npm publish --access public
```

在此之前，可用 `npm pack --dry-run` 低成本地查看实际会发布的内容。

## 6. 后续发布

1. 提升 `package.json` 中的 `version`（语义化版本）。
2. 提交。
3. 创建 tag `vX.Y.Z` 并推送该 tag；同一工作流会完成发布并创建 GitHub Release。

npm 会拒绝已存在的版本，因此每次发布都需要新的版本号——不要复用 tag 或版本号。
如果发布了有问题的版本，可用 `npm deprecate` 标记该具体版本，并引导用户使用修复版本。
`npm unpublish` 仅在 npm 的宽限期内可用，应作为最后手段，因为它会破坏已经解析到
该版本的用户。

## 7. 更新内置上游固定版本

`virtuoso-bridge-lite/` 跟踪 virtuoso-bridge-lite 上游，具体精确提交记录在
`virtuoso-bridge-lite.pin.json`。pin 本身是稳定的：`.gitmodules` 不声明 `branch`，
`git submodule update` 总是检出记录的 gitlink，上游 `main` 更新不会静默改变内置源码。
不要执行 `git submodule update --remote`——它是唯一会跟随移动分支的命令。需要主动
更新固定版本时：

```powershell
git -C virtuoso-bridge-lite fetch origin
git -C virtuoso-bridge-lite checkout <sha>
```

然后把 `virtuoso-bridge-lite.pin.json` 的 `commit` 和 `commitDate` 改为当前检出的提交，
并将 gitlink 与 pin 一起提交：

```powershell
git add virtuoso-bridge-lite virtuoso-bridge-lite.pin.json
git commit -m "chore: bump virtuoso-bridge-lite to <sha>"
```

之后按常规流程打 tag 发布。`virtuoso-bridge-lite/` gitlink 与
`virtuoso-bridge-lite.pin.json` 不一致时 CI 会失败，因此只更新一半的 pin 无法发布。

## 8. 用户获得的内容

发布的 npm tarball 包含插件所装 `virtuoso-bridge-lite/` 的打包子集——`pyproject.toml`、
`README.md`、`AGENTS.md`、`LICENSE`、`mcp_server.py`、`src/**` 和 `skills/**`——
再加上 `virtuoso-bridge-lite.pin.json` 与插件自身的 JavaScript、运行时脚本、文档和
locale 文件。因此通过 DSH 安装 bundle 既不需要 git，也不需要 submodule：插件会自建
venv 并从打包源码 pip 安装。开发用 checkout 不同：它需要执行
`git submodule update --init virtuoso-bridge-lite`，`virtuoso-bridge-lite/` 缺失时插件
会给出可操作的错误提示。

## 9. 安全提示

- `scripts/check-no-private-data.mjs` 在 CI 和发布流程中运行，防止私有数据进入公开
  仓库或 tarball。
- 不要提交 SSH 材料（`~/.ssh`、私钥）、npm 或 GitHub token、`.local-backup/`
  （被 gitignore 的本地备份目录），或任何来自 `%USERPROFILE%` 的内容。
- 连接配置和守护进程 token 属于本地插件状态，绝不能加入仓库。
- token 只保存在 GitHub 的 `NPM_TOKEN` secret 中；一旦泄露请立即轮换。
