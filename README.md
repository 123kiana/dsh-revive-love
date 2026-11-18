# 复活吧我的爱人（dsh-revive-love）

> **非官方插件。** 这是第三方作品，与 DeepSeek 官方无关。使用时需要 DSH 的官方「DeepSeek 会话导入」插件处于启用状态。

把一条快要撑爆上下文的 DeepSeek 对话捞出来，只保留最近若干轮，重新导入成一条能接着聊的会话。

DSH 的上下文窗口是 1048576 token，通常还要为输出预留约 25 万。历史一旦超长，每次请求都会撞上限；
这个插件让你在导入之前就把它截短，于是新会话从一开始就装得下。

## 安装

### 从 npm 安装（推荐）

```bash
pnpm add dsh-revive-love
```

或者在 DSH 插件页的 **Add plugin** 里直接填包名 `dsh-revive-love`。

装完**完全退出 DSH 再打开**（客户端模块在启动时加载，只刷新页面不够）。

### 从 GitHub Release 安装（不装包管理器时用这个）

1. 到 [Releases](../../releases/latest) 下载最新的 `dsh-revive-love-<version>-release.zip`
2. 解压得到 `dsh-revive-love` 目录
3. DSH → 插件页 → **Add plugin** → 选择这个目录
4. 完全退出 DSH 再打开

### 从源码安装（给要改代码的人）

```bash
git clone https://github.com/123kiana/dsh-revive-love.git
```

然后在 DSH 插件页 **Add plugin** 里选克隆下来的目录。

> 上面两种手动方式安装的都是本地目录依赖（`link:`），目录一挪动插件就失效。
> 想以后能用 `pnpm update` 升级，请走 npm 那条。

### 装之前先确认

官方「DeepSeek 会话导入」插件（`@deepseek-ai/dsh-deepseek-chat-import`）已启用。
本插件复用它把结果落盘；它不在时会退化成"下载 zip"，需要你手工导入。

## 依赖

- **需要**：`@deepseek-ai/dsh-deepseek-chat-import`（官方「DeepSeek 会话导入」插件）处于启用状态
- **需要**：`@deepseek-ai/dsh-api-session-controller`（提供会话列表刷新）

除此之外没有第三方依赖：只用 Node 内建模块，ZIP 读写与 CRC32 都是自己实现的。

## 用法

侧边栏「新建会话」右侧多出一颗心电图按钮，点开是三步向导：

1. **上传**：选择从 DeepSeek 官网导出的 `deepseek_data-*.zip`（`export_format_version: 3`）。
   如果导出包已经在你的**下载 / 桌面 / 文档**文件夹里，向导会自动把它们列出来，点一下就能加载，
   不用再手动选文件（纯本地扫描，不上传、不联网）
2. **选择对话**：列出压缩包里所有对话，按最后更新时间倒序，可按标题搜索。
   超过 500 轮的带「推荐处理」角标
3. **设定保留轮数**：滑块或数字框，上限 500 轮；可以填一句「补充说明」，它会成为新会话的第一条消息

点「生成」后，浏览器把重建好的 zip 交给官方导入管线，导入完成后自动刷新会话列表。

## 配置

`index.js` 顶部几个常量：

| 常量 | 默认 | 含义 |
|---|---|---|
| `RECOMMEND_TURNS` | `500` | 超过这么多轮，列表里带「推荐处理」角标 |
| `MAX_KEEP_TURNS` | `500` | 向导里允许保留的最大轮数 |
| `HISTORY_BUDGET_TOKENS` | `790000` | 上下文窗口减去输出预留，用于超预算提示 |
| `MAX_ARCHIVE_BYTES` | `256 MiB` | 单次上传上限 |
| `MAX_ENTRY_BYTES` | `256 MiB` | 单个压缩包条目解压后的上限 |

## 边界

- 一次只处理一个对话
- 上传上限 256 MiB，整个压缩包在处理期间驻留内存；同一时刻只保留一份待生成的上传（15 分钟有效）
- 预览最多列出 200 个对话
- 只支持 `export_format_version: 3`，不支持 ZIP64
- 保留的是每轮 USER `REQUEST` 与 ASSISTANT `RESPONSE` 原文；思考、工具调用、附件、图片不会进入新会话
- **不写**任何 `session*.jsonl*` 会话日志，所有会话都由官方导入管线落盘

## 隐私

导出的压缩包只在**本机内存**里解析，不落盘、不联网、不收集任何数据；
结果只 POST 给本机 DSH 的官方导入路由。

「已下载的导出包」扫描只读取下载 / 桌面 / 文档三个文件夹里匹配 `deepseek_data*.zip` 的文件名与修改时间，
不读取内容、不离开本机；加载时才读文件内容，并再次校验路径确实在这三个目录下。详见 [SECURITY.md](SECURITY.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 123kiana。
