# 隐私说明 · Privacy Policy

**简体中文** · [English](#english)

## 这个扩展不收集任何数据

没有服务端，没有分析统计，没有任何遥测。它不会把你的文档、账号信息或使用行为发送到任何地方。

### 它具体做了什么

| 行为 | 说明 |
| --- | --- |
| 调用飞书 / Lark 的网页接口 | 用你浏览器里**已有的登录态**，调用飞书自己的接口列出文档、创建导出任务、下载产物。域名限于 `*.feishu.cn` 和 `*.larksuite.com` |
| 读取一个 Cookie 值 | 只读 `_csrf_token`，飞书的接口要求把它放进请求头。这个值不会离开当前页面 |
| 抓取文档里的图片 | 导出 Markdown 时，从飞书的图床把图片取回来放进 zip。这些链接约 24 小时后失效，所以必须存到本地 |
| 存少量设置 | 格式、几个开关、面板语言、悬浮按钮位置，存在页面的 `localStorage` 里。都是你自己的选择，不含文档内容 |
| 把文件写到你的下载目录 | 导出的产物直接下载到本地，不经过任何中转 |

### 它没有做的事

- 不上传文档内容、标题、账号或任何标识符
- 不连接飞书 / Lark 与 GitHub（仅面板里的仓库链接）之外的任何服务
- 不收集使用统计、点击行为或错误报告
- 不读取飞书之外任何网站的页面（`manifest.json` 里只声明了这两个域）

代码全部开源，`extension/` 目录里没有压缩或混淆的文件，可以逐行审阅。

---

<a id="english"></a>

## English

**This extension collects no data.** There is no server, no analytics, and no telemetry. Nothing about your documents, account, or usage is sent anywhere.

### What it actually does

| Action | Detail |
| --- | --- |
| Calls Feishu / Lark web APIs | Uses the session **already present in your browser** to list documents, create export jobs and download the results. Restricted to `*.feishu.cn` and `*.larksuite.com` |
| Reads one cookie value | Only `_csrf_token`, which Feishu's API requires in a request header. The value never leaves the page |
| Fetches images from documents | When exporting Markdown, images are pulled into the zip. Their links expire in about 24 hours, so saving them locally is the point |
| Stores a few settings | Format, a few toggles, panel language and the floating button's position, in the page's `localStorage`. Your choices only — no document content |
| Writes files to your Downloads folder | Exports download directly to your machine; nothing is relayed |

### What it does not do

- Never uploads document content, titles, accounts, or any identifier
- Never contacts any service other than Feishu / Lark (and the repository link in the panel)
- Collects no usage statistics, click tracking, or crash reports
- Reads no site other than Feishu / Lark — `manifest.json` declares only those two domains

The source is fully open, with no minified or obfuscated files under `extension/`.
