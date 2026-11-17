# 发布到 GitHub（不用装 git）

全程在 GitHub 网页上完成，本机不需要 `git` 命令。

## 一、建仓库

1. GitHub → 右上角 **+** → **New repository**
2. 名字填 `dsh-revive-love`（和 `package.json` 的 `name` 保持一致）
3. 选 **Public**，**不要**勾选 "Add a README file"（我们已有）
4. Create repository

## 二、上传文件

新仓库页面会让你看到上传入口，两种方式任选：

- 点 **uploading an existing file**，把 `本仓库目录` 里的**所有文件和文件夹**拖进去
  （`index.js`、`client.js`、`package.json`、`cordis.patch.yml`、`icon.svg`、`README.md`、
  `LICENSE`、`CHANGELOG.md`、`.gitignore`、`docs/`、`locale/`）
- 或者安装 GitHub Desktop 后拖进去，效果一样

提交信息写 `v1.0.0`，点 **Commit changes**。

> `.gitignore` 里已经排除了 `node_modules/`、`NOTES.md`、`*.zip`——内部笔记和构建产物不会被传上去。

## 三、发 Release（关键一步，别人靠它安装）

1. 仓库右侧 **Releases** → **Create a new release**
2. **Choose a tag** 填 `v1.0.0` → 点 "Create new tag on publish"
3. **Release title** 填 `v1.0.0`
4. **Describe this release** 粘贴：

```
首个公开版本。

## 安装
1. 下载下面的 dsh-revive-love-1.0.0.zip
2. 解压得到 dsh-revive-love 目录
3. DSH → 插件页 → Add plugin → 选这个目录
4. 完全退出 DSH 再打开

## 依赖
需要官方「DeepSeek 会话导入」插件处于启用状态。
```

5. **Attach binaries**：把 `dsh-revive-love-1.0.0-release.zip` 拖进去
6. 点 **Publish release**

## 四、更新版本时

1. 改 `package.json` 的 `version`
2. `CHANGELOG.md` 顶部加一节
3. 网页上把改动过的文件重新上传（或用 GitHub Desktop 提交）
4. 新建一个 tag 的 Release，附上新的 zip

## 关于"按名字安装"

GitHub 仓库名不会被 DSH 当成包名解析。别人想一条命令安装需要包发布在 npm registry 上；
只发 GitHub 时，安装方式是下载 Release 里的 zip 后 **Add plugin**。

（从 git 地址直接安装依赖本机有 `git` 命令；没有 `git` 的环境用 zip 方式。）
