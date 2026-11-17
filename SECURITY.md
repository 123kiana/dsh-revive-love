# 安全策略

## 报告漏洞

请**不要**用公开 issue 报告安全问题。用 GitHub 的 [Private vulnerability reporting](https://github.com/123kiana/dsh-revive-love/security/advisories/new)，
或者在仓库里开一个 issue 只写"有安全问题，请提供联系方式"，维护者会私下联系你。

## 这个插件处理什么数据

- 你把 DeepSeek 官网导出的 `deepseek_data-*.zip` 交给它
- 它在**本机内存**里解析压缩包、裁剪对话、重新打包
- 结果只 POST 给**本机** DSH 的官方导入路由（`api/deepseek-chat-import/archive`）

**它不落盘、不联网、不收集、不上传任何数据到外部服务器。**

## 已知的边界与防护

| 项 | 现状 |
|---|---|
| 单次上传上限 | 256 MiB（整包驻留内存） |
| 单个条目解压上限 | 256 MiB，且校验解压后长度与中央目录声明一致 |
| ZIP 炸弹 | 已防护：`inflateRawSync` 带 `maxOutputLength`，声明超限直接拒绝 |
| ZIP64 | 不支持，遇到报错退出 |
| 路径穿越 | 不存在：条目全在内存里读，不按路径落盘 |
| 命令执行 | 无 `eval`、无 `child_process`、无动态 `require` |
| 路由鉴权 | 依赖 DSH 自身的鉴权；插件侧只额外做了同源校验 |
| 同源校验 | 请求**没有** `Origin` 头时放行（为兼容非浏览器客户端），这是**有意为之**的宽松点 |

## 支持的版本

只维护最新发布版本。
