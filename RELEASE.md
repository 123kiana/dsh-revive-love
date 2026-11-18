# 发布手册

从 1.2.2 起，发布不依赖本机 `git`：走 npm CLI + GitHub REST API。

> 以下命令都在**仓库根目录**（含 `package.json` 的那一层）执行。
> 产物统一放进仓库旁边的 `_dist/`，该目录已在 `.gitignore` 里。

## 发布纪律

**只有用户能感知到的变化才升版本号。** 文案、注释、README、文档修正都不单独发版。

- **文档改动直接提交到 GitHub `main`，不动 npm。** npm 页面上的 README 是发布那一刻的快照，
  想更新它就必须发一个新版本；但为了一句话的描述去发版不值得，让 npm 页面稍微过时即可。
- **小改动攒着。** 攒到下一个有实质变更（修 bug、改行为）的版本一起发。
- **一个版本可以包含多轮修复。** 1.2.2 就累积了三十多项改动，这是正常的，不必为了"干净"拆成多次发布。
- **源码必须和 npm 同步。** 发完 npm 之后，把同样的文件提交进 `main`，否则仓库里的代码会悄悄落后
  （1.2.2 发布时漏了这一步，仓库一度停在 1.1.1、缺 `amplify.js`）。

## 0. 发布前检查

- `package.json` 的 `version` 与 `CHANGELOG.md` 顶部小节同名
- `npm run check` 通过（等价于对三个 JS 文件各跑一次 `node --check`）
- 本机实测跑过一轮增幅模式（改动了 `amplify.js` 或 `index.js` 时必做）
- 三项审查（法律 / 合规 / 安全）的阻断项为 0

## 1. 打两个包

```powershell
$dist = Join-Path $PWD '_dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null

# npm 包：package.json 的 files 白名单生效
npm pack --cache "$dist\npm-cache" --pack-destination $dist

# GitHub Release 附件：解压即得 dsh-revive-love 目录
$stage = Join-Path $dist 'stage'
$root = Join-Path $stage 'dsh-revive-love'
New-Item -ItemType Directory -Path $root -Force | Out-Null
Copy-Item * -Recurse -Force $root
Compress-Archive -Path $root -DestinationPath "$dist\dsh-revive-love-<版本>-release.zip" -Force
Remove-Item $stage -Recurse -Force
```

`--cache` 指向 `_dist`，是为了绕开某些机器上 `%LOCALAPPDATA%\npm-cache` 不可写的情况。

## 2. 发布到 npm

```powershell
$rc = Join-Path $dist 'npmrc'
'registry=https://registry.npmjs.org/' | Set-Content $rc
'//registry.npmjs.org/:_authToken=<token>' | Add-Content $rc
npm publish "$dist\dsh-revive-love-<版本>.tgz" --userconfig $rc
```

- 用 `--userconfig` 指向临时 npmrc，别动全局配置
- 不要设 `NODE_AUTH_TOKEN` 环境变量（会覆盖 userconfig）
- 若 `www.npmjs.com` 被 Cloudflare 挡，验证改走 `registry.npmjs.org/<包名>` 的 JSON

## 3. 发 GitHub Release

用 REST API，token 只放在命令参数里：

```
POST https://api.github.com/repos/123kiana/dsh-revive-love/releases
  tag_name=v<版本>
  name=v<版本>
  body=<release-notes 的内容>

POST https://uploads.github.com/repos/123kiana/dsh-revive-love/releases/<id>/assets?name=dsh-revive-love-<版本>-release.zip
  Content-Type: application/zip
  body=<zip 二进制>
```

## 4. 发布后

- 检查 `pnpm add dsh-revive-love` 能装到新版本
- 下载 Release 的 zip，解压后走一次 **Add plugin** 验证
- 确认 README 的安装段没有写死旧版本号

## 不要做的事

- 不要手写 `session*.jsonl*` 会话日志（必须走官方导入管线）
- 不要把内部笔记 `NOTES.md`、`_dist/`、日志、`node_modules` 打进包
- `files` 里不要放裸目录名，用 `docs/*.md` 这种精确模式
