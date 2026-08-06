# Chrome 应用商店提交材料

**已上架**：https://chromewebstore.google.com/detail/lomkhccnocgfifghblhfidifhnilcgdi

提交时逐项照抄。**名称和简介不用在这里填** —— 它们来自 `extension/_locales/*/messages.json` 的 `extName` / `extDesc`，商店会按用户语言自动取，改这两处即可（测试会守住 45 / 132 字符上限）。

## 基本信息

| 字段 | 填什么 |
| --- | --- |
| 类别 | 生产力（Productivity）|
| 语言 | 简体中文、English |
| 官方网站 | `https://github.com/rockbenben/feishu-lark-batch-export` |
| 支持网址 | 同上的 Issues 页 |
| 隐私政策网址 | `https://github.com/rockbenben/feishu-lark-batch-export/blob/main/PRIVACY.md`（审核会点开，仓库必须先是 public）|

## 屏幕截图

`assets/` 下已有 1280×800 的成品，中英各三张，按这个顺序传：

| 文件 | 展示的是 |
| --- | --- |
| `store-1-main.png` | 列出知识库、勾选文档（含半选和被禁用的思维笔记）|
| `store-2-more.png` | 更多设置展开，每个开关都带解释 |
| `store-3-running.png` | 导出进行中：进度、剩余时间、日志 |

英文版是同名加 `-en`。改了界面就重新出图，别让商店里挂着过期的截图。

## 单一用途说明

> 把飞书 / Lark 云文档批量导出到本地。用户在扩展面板里勾选多个文档，扩展按顺序调用飞书自己的导出接口，把结果打包成一个 zip 下载到本地。除此之外不做任何事。

## 权限理由

**`host_permissions: https://*.feishu.cn/*`、`https://*.larksuite.com/*`**

> 扩展需要在飞书 / Lark 的文档页面上运行，以读取用户有权访问的文档目录树，并调用飞书自己的导出接口。图片托管在同一集团的独立子域（如 `internal-api-drive-stream.feishu.cn`、`internal-api-drive-stream-jp.larksuite.com`），导出 Markdown 时需要跨子域取回图片，因此按域名整体声明。范围仅限这两个域，不含任何其它站点。

**没有申请任何 `permissions`。** 不用 `storage`（设置存在页面的 localStorage）、不用 `downloads`（用 `<a download>` 触发）、不用 `tabs`（`chrome.tabs.sendMessage` 只用回调里给的 `tab.id`，不读取标签页属性）。

## 数据使用声明

表单里的每一项都选「否 / 不收集」，并勾选三条合规声明：

| 数据类型 | 是否收集 |
| --- | --- |
| 个人身份信息 / 健康 / 财务 / 身份验证信息 | 否 |
| personal communications / 位置 / 网页浏览记录 | 否 |
| 用户活动（点击、鼠标位置等）| 否 |
| 网站内容（文本、图片、文件）| **否** —— 文档内容只在用户的浏览器和本地磁盘之间流动，不经过任何服务器 |

要勾的三条：不出售或转让给第三方（与核心功能无关的用途）、不为无关目的使用或转让、不用于判定信用状况或放贷。

## 详细说明

### 简体中文

> 飞书的导出只能一篇一篇点。这个扩展让你在知识库树里勾一批，一次拿一个 zip。
>
> **怎么用**
> 打开飞书任意页面，点右下角的小按钮，面板按 1 → 2 → 3 走完就行：列出文档 → 勾选 → 选格式导出。
>
> **能导出什么**
> 文档（新版 / 旧版）导成 Markdown、Word 或 PDF；表格和多维表格导成 xlsx；附件按原文件下载。知识库和云空间都支持，飞书和 Lark 都能用。
>
> **图片会一并存到本地**
> 这不是锦上添花：飞书导出的 Markdown 里，图片是一串带签名的链接，约 24 小时后失效。不存下来的话，你的备份过几天就只剩文字了。扩展会把图片抓进 zip，并把链接改成相对路径。
>
> **省心的地方**
> 目录结构原样保留；勾目录连带勾上它下面的全部文档，按住 Alt 只选当前这条；「最近改过的」一次勾出 7 / 30 / 90 天内改动的，适合增量备份；多个文件自动打包成一个 zip，不会触发浏览器的多文件下载弹窗；串行导出并显示进度和剩余时间；单篇失败不中断队列，跑完可以重试。
>
> **隐私**
> 没有服务端，不收集任何数据。只用你浏览器里已有的登录态调用飞书自己的接口，文档只在你的浏览器和本地磁盘之间流动。代码开源，没有压缩或混淆的文件。

### English

> Feishu exports one document at a time. This extension lets you check off a batch in the wiki tree and get a single zip.
>
> **How it works**
> Open any Feishu page, click the small button in the bottom-right corner, and follow 1 → 2 → 3: list documents, check the ones you want, pick a format and export.
>
> **What it exports**
> Documents (new and legacy) as Markdown, Word or PDF; sheets and bases as xlsx; file attachments as-is. Works on both wikis and drive documents, on Feishu and Lark alike.
>
> **Images are saved alongside**
> Not a nicety: in Feishu's exported Markdown, images are signed URLs that expire in about 24 hours. Leave them and your backup is text-only within days. The extension pulls them into the zip and rewrites the links to relative paths.
>
> **Details that save you time**
> The folder structure is preserved. Checking a folder checks everything under it; Alt-click affects only that row. "Recently edited" selects everything touched in the last 7 / 30 / 90 days, which is what incremental backups need. More than one file is packed into a single zip, so the browser never asks you to allow multiple downloads. Export runs serially with progress and a remaining-time estimate. A failure never stops the queue, and you can retry when it finishes.
>
> **Privacy**
> No server, no data collection. It uses the session already in your browser to call Feishu's own APIs; your documents move only between your browser and your disk. The source is open, with no minified or obfuscated files.

## 提交前再跑一遍

```bash
node --test test.mjs          # 逻辑与两份语言文件
```

打 `v<manifest 里的版本>` 的 tag，GitHub Actions 会跑测试、校验 tag 与 manifest 版本一致、打包出可直接上传的 zip。**商店上传的就是那个 zip。**
