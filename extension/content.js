// 飞书 / Lark 文档批量导出 —— content script
// 样式在 panel.css，由 manifest 注入（扩展 CSS 不受页面 CSP 限制）。
// 外面这层 IIFE 是为了让 test.mjs 能用 new Function 求值后提前 return。

(function () {
  'use strict';

  // ───────────────────────── 纯函数（test.mjs 覆盖这几个） ─────────────────────────

  // obj_type -> 导出接口的 type 与可用扩展名。首个扩展名即「自动」模式的默认值。
  // 实测结果见 docs/superpowers/specs/2026-08-04-feishu-batch-export-design.md
  // key 是 _locales 里的消息名，不是显示文本 —— 这样这张表和纯函数都跟语言无关。
  const TYPES = {
    2:  { key: 'typeDoc',      api: 'doc',     exts: ['md', 'docx', 'pdf'] },
    22: { key: 'typeDocx',     api: 'docx',    exts: ['md', 'docx', 'pdf'] },
    3:  { key: 'typeSheet',    api: 'sheet',   exts: ['xlsx'] },
    8:  { key: 'typeBitable',  api: 'bitable', exts: ['xlsx'] },
    12: { key: 'typeFile',     api: null,      exts: [] }, // 不用导出任务，直接下原文件
    11: { key: 'typeMindnote', api: null,      exts: null }, // 飞书不给任何可用扩展名
  };

  // 飞书标准分享页的第一段路径 -> obj_type。wiki 的 URL token 还要经 getNode
  // 转成真实 obj_token，所以不放在这张直接映射表里。
  const URL_TYPES = Object.freeze({
    docx: 22, docs: 2, sheets: 3, base: 8, file: 12,
  });

  const DRIVE_URL_PATHS = Object.freeze({
    0: 'drive/folder', 4: 'drive/folder',
    2: 'docs', 22: 'docx', 3: 'sheets', 8: 'base', 12: 'file',
  });

  // 返回 {api, ext} / {api:null} 表示直下附件 / null 表示不支持。
  // want 不在该类型支持范围内时退回该类型的默认扩展名（例如选了 md 却遇到表格 → xlsx）。
  function pickFormat(objType, want) {
    const t = TYPES[objType];
    if (!t || t.exts === null) return null;
    if (t.api === null) return { api: null, ext: null };
    return { api: t.api, ext: t.exts.includes(want) ? want : t.exts[0] };
  }

  function sanitizeName(name) {
    return String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+/, '')
      .trim()
      .slice(0, 80) || 'untitled';
  }

  // zip 内的图片目录名要能安全地出现在 markdown 链接里 —— 空格和括号会直接把
  // ![](…) 语法弄断，渲染器就找不到图了。中文本身没问题，不必编码成一串 %E6。
  const safeSlug = (name) => sanitizeName(name).replace(/[\s()[\]<>#?%&]+/g, '_');

  // flatten 是深度优先 ⇒ 第 i 项的后代就是它后面 depth 更大的连续一段。
  // 返回该段的结束下标（不含），i 自己没有后代时等于 i+1。
  function descendantEnd(rows, i) {
    let j = i + 1;
    while (j < rows.length && rows[j].depth > rows[i].depth) j++;
    return j;
  }

  // 云空间的节点跟知识库节点长得不一样：字段叫 name/type/token 而不是
  // title/obj_type/wiki_token。在这里归一，后面整条流水线就不用管来源了。
  // type 编号跟 wiki 的 obj_type 是同一套，文件夹是 0（子文件夹）或 4（空间根）。
  const isFolder = (n) => n.type === 0 || n.type === 4;
  // obj_token 缺失时退回 token：JSON.stringify 会把值为 undefined 的键整个丢掉，
  // 于是 /export/create/ 收到一个没有 token 的请求体，回 1002 no permission ——
  // 看起来像权限问题，其实是我们没把文档标识发过去。退回 token 未必对，但一定
  // 好过什么都不发；真发错了飞书会明确报错，而不是静默导出别的东西。
  function sourceUrlForNode(origin, node, source) {
    const existing = String((node && node.source_url) || '').trim();
    if (existing) return existing;
    const base = String(origin || '').replace(/\/+$/, '');
    const objType = node && (node.obj_type ?? node.type);
    const path = source === 'wiki' ? 'wiki' : DRIVE_URL_PATHS[objType];
    const token = source === 'wiki'
      ? node && node.wiki_token
      : objType === 0 || objType === 4
        ? node && (node.token || node.wiki_token)
        : node && (node.url_token || node.obj_token || node.token);
    return base && path && /^[A-Za-z0-9]+$/.test(String(token || ''))
      ? `${base}/${path}/${token}`
      : '';
  }

  function asNode(n, origin = '') {
    const node = {
      title: n.name,
      obj_token: n.obj_token || n.token,
      obj_type: n.type,
      wiki_token: n.token,
      url_token: n.obj_token || n.token,
      has_child: isFolder(n),
      edit_time: Number(n.edit_time) || 0,
    };
    const sourceUrl = sourceUrlForNode(origin, n, 'drive');
    return sourceUrl ? { ...node, source_url: sourceUrl } : node;
  }

  // 知识库节点把修改时间放在 detail_info 里，云空间节点直接在顶层。统一取秒。
  const editTime = (node) =>
    Number((node && node.edit_time) || (node && node.detail_info && node.detail_info.edit_time) || 0);

  // 剩余秒数按已完成项的实际平均耗时估，不用固定值 —— 文档大小差异很大，
  // 拿一篇的耗时去乘剩余篇数会离谱。估不出来时返回 null，交给调用方决定怎么说。
  // 只算数不成句，措辞留给 _locales。
  function etaSeconds(doneCount, elapsedMs, totalCount) {
    if (doneCount < 1 || doneCount >= totalCount) return null;
    return Math.round((elapsedMs / doneCount) * (totalCount - doneCount) / 1000);
  }

  // 序号按目录分别计数。目录结构关掉时 dirPrefix 恒为 ''，自然退化成全局计数；
  // 开着时每个文件夹各自从 1 开始 —— 否则文件夹里会出现 007、019 这种跳号，
  // 序号本来是为了保住顺序，跳号看着倒像是坏了。
  function nextSeq(counters, dirPrefix) {
    const n = (counters.get(dirPrefix) || 0) + 1;
    counters.set(dirPrefix, n);
    return n;
  }

  // 文件名规则：序号和父目录名都可关。opts = {number, parent}
  function buildStem(index, parentTitle, title, opts) {
    const parts = [];
    if (opts.number) parts.push(String(index).padStart(3, '0'));
    if (opts.parent && parentTitle) parts.push(parentTitle);
    parts.push(title);
    return sanitizeName(parts.filter(Boolean).join('-'));
  }

  // zip 内是否按知识库层级建子目录。每段都过 safeSlug —— 目录名会出现在 md 的
  // 相对路径里，空格照样会把 ![](…) 弄断。
  function buildDirPrefix(path, enabled) {
    if (!enabled || !path.length) return '';
    return `${path.map(safeSlug).join('/')}/`;
  }

  // 标题本身就以目标扩展名结尾时别再加一遍，否则会出现 笔记.md.md
  function withExt(stem, ext) {
    if (!ext) return stem;
    return stem.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? stem : `${stem}.${ext}`;
  }

  // 可选地把 URL 中的唯一 token 加到文档文件名末尾。标题主干仍限制在 80 字符，
  // 但 token 必须完整保留，否则这个选项就失去了消歧和追溯价值。
  function addTokenToFilename(filename, token, enabled) {
    const name = String(filename == null ? '' : filename);
    const value = String(token == null ? '' : token).trim();
    if (!enabled || !value) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    if (stem === value || stem.endsWith(`-${value}`)) return name;
    const suffix = `-${value}`;
    const maxHead = Math.max(1, 80 - suffix.length);
    const head = stem.slice(0, maxHead).replace(/[-\s]+$/, '') || 'untitled';
    return `${head}${suffix}${ext}`;
  }

  // 按 cookie 名精确取值。不能用 /name=([^;]+)/ 去 match 整条 cookie 串：
  // `_csrf_token=` 正好是 `passport_csrf_token=` 的后缀，飞书页面上后者就在、还常排在
  // 前面，于是子串匹配会把别人的值当成 CSRF token 发出去 —— /export/create/ 一律
  // 403 + 纯文本 csrf token error。值里可能有 base64 的 `=`，所以只切第一个 `=`。
  function readCookie(cookieString, name) {
    for (const part of String(cookieString == null ? '' : cookieString).split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }

  // /wiki/ 后面不一定是节点 token。知识库首页是 /wiki/space/<space_id>，还有
  // /wiki/settings/… 这类功能页 —— 直接取第一段会把 `space` 当成 wiki_token 发给
  // get_node，接口报错，表现是「我对这个知识库有权限，却一篇也列不出来」。
  // 打开别人的知识库时落地页往往正是空间首页，所以这条路径很常见。
  const WIKI_RESERVED = new Set([
    'space', 'spaces', 'settings', 'setting', 'recent', 'favorite', 'favorites',
    'trash', 'search', 'home', 'template', 'templates', 'shared', 'wiki',
  ]);

  // 返回节点 token；停在知识库的非文档页时返回 null。
  function wikiTokenFromPath(pathname) {
    const m = String(pathname == null ? '' : pathname).match(/\/wiki\/([A-Za-z0-9]+)/);
    if (!m) return null;
    return WIKI_RESERVED.has(m[1].toLowerCase()) ? null : m[1];
  }

  // 云空间文件夹页：/drive/folder/<token>。不在文件夹页上时返回 null。
  function driveFolderTokenFromPath(pathname) {
    const m = String(pathname == null ? '' : pathname).match(/\/drive\/folder\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }

  // 当前页面该默认选哪个来源。飞书是 pushState 单页应用，站内跳转不重载内容脚本，
  // 所以每次打开面板都要按当前 URL 重算，不能只在建面板时算一次 —— 否则从云空间
  // 首页点进别人分享的文件夹后，下拉还停在「我的云空间」，列出来的全是自己的东西。
  // /wiki/ 这里故意用宽匹配（不用 wikiTokenFromPath）：停在知识库首页时也选中 wiki，
  // 用户才能拿到那句「点开任意一篇文档」的提示，默默切到云空间反而把人带偏。
  function sourceForPath(pathname) {
    if (/\/wiki\//.test(pathname)) return 'wiki';
    if (driveFolderTokenFromPath(pathname)) return 'folder';
    return 'drive';
  }

  // TXT 来源只认当前租户的标准两段路径：/<类型>/<token>。查询参数和锚点不参与
  // token 判断；保留规范化后的原 URL，便于后续扩展和排查输入。
  function parseDocumentUrl(raw, currentOrigin) {
    let url;
    try { url = new URL(String(raw == null ? '' : raw).trim()); }
    catch (e) { throw new Error('invalid'); }
    if (url.protocol !== 'https:') throw new Error('protocol');
    if (url.origin !== currentOrigin) throw new Error('origin');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) throw new Error('path');
    const [kind, urlToken] = parts;
    if (!/^[A-Za-z0-9]+$/.test(urlToken)) throw new Error('token');
    if (kind !== 'wiki' && !(kind in URL_TYPES)) throw new Error('path');
    return {
      url: url.href, kind, urlToken,
      objType: kind === 'wiki' ? null : URL_TYPES[kind],
    };
  }

  function parseUrlText(text, currentOrigin) {
    const items = [];
    const errors = [];
    const duplicates = [];
    const seen = new Set();
    String(text == null ? '' : text).split(/\r?\n/).forEach((raw, i) => {
      const lineNumber = i + 1;
      const line = raw.replace(/^\uFEFF/, '').trim();
      if (!line) return;
      try {
        const item = parseDocumentUrl(line, currentOrigin);
        const key = `${item.kind}:${item.urlToken}`;
        // 丢掉的行也要有下落：备份工具里静默少一条，比多一行日志麻烦得多。
        if (seen.has(key)) { duplicates.push({ lineNumber, raw: line }); return; }
        seen.add(key);
        items.push({ ...item, lineNumber });
      }
      catch (e) { errors.push({ lineNumber, raw: line, reason: e.message }); }
    });
    return { items, errors, duplicates };
  }

  function buildDirectNode(item) {
    return {
      title: item.urlToken,
      obj_token: item.urlToken,
      obj_type: item.objType,
      wiki_token: item.urlToken,
      url_token: item.urlToken,
      source_url: item.url,
      has_child: false,
      edit_time: 0,
    };
  }

  // 普通文档的类型和 token 已包含在 URL 中，不需要再访问网页；wiki URL 则必须把
  // wiki token 转成实际 obj_token。依赖作为参数传入，让两条分支的网络行为可测试。
  async function resolveUrlItem(item, getWikiNode) {
    if (item.kind === 'wiki') {
      const node = await getWikiNode(item.urlToken);
      return { ...node, url_token: item.urlToken, source_url: item.url, has_child: false };
    }
    return buildDirectNode(item);
  }

  function normalizeExportResult(result, fallbackExt) {
    return {
      fileToken: result.file_token,
      ext: result.file_extension || fallbackExt,
      fileName: String(result.file_name || '').trim(),
    };
  }

  function titleFromExportResult(fallbackTitle, fileName, ext) {
    const name = String(fileName || '').trim();
    if (!name) return fallbackTitle;
    const suffix = ext ? `.${ext}` : '';
    return suffix && name.toLowerCase().endsWith(suffix.toLowerCase())
      ? name.slice(0, -suffix.length) : name;
  }

  function filenameFromContentDisposition(header) {
    const value = String(header || '');
    const extended = value.match(
      /(?:^|;)\s*filename\*\s*=\s*(?:"([^"]*)"|([^;]*))/i,
    );
    const basic = value.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
    const decode = (match, rawFallback, stripCharset) => {
      if (!match) return '';
      const raw = String(match[1] ?? match[2]).trim();
      const encoded = stripCharset ? raw.replace(/^[^']*'[^']*'/, '') : raw;
      try { return decodeURIComponent(encoded); }
      catch (error) {
        if (!(error instanceof URIError)) throw error;
        return rawFallback ? encoded : '';
      }
    };
    return decode(extended, false, true) || decode(basic, true, false);
  }

  function titleFromDownload(fallbackTitle, exportFileName, responseFileName, ext) {
    return titleFromExportResult(
      fallbackTitle,
      ext === null ? responseFileName : exportFileName,
      ext,
    );
  }

  async function requestAttachmentFilename(token, requestId, sendMessage, trackRequest) {
    const release = trackRequest({
      async abort() {
        try { await sendMessage({ type: 'fbe-file-name-cancel', requestId }); }
        catch (error) { console.warn('Failed to cancel attachment filename request', error); }
      },
    });
    try {
      const response = await sendMessage({ type: 'fbe-file-name', token, requestId });
      if (!response) throw new Error('file name response missing');
      if (response.error) throw new Error(response.error);
      const fileName = filenameFromContentDisposition(response.contentDisposition);
      if (!fileName) throw new Error('Content-Disposition filename missing');
      return fileName;
    } finally {
      release();
    }
  }

  // 小于 1 MB 时显示 KB。几个 md 文件本来就到不了 1 MB，
  // 报「0.0 MB」看着像是什么都没导出来。单位不用翻译。
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  async function copyLogText(text, writeText) {
    const value = String(text == null ? '' : text);
    if (!value) return false;
    await writeText(value);
    return true;
  }

  function appendSourceUrl(message, url) {
    const source = String(url == null ? '' : url).trim();
    return source ? `${message} · ${source}` : message;
  }

  async function retryAsync(task, retryCount, wait, delayMs, shouldRetry = () => true) {
    for (let attempt = 0; ; attempt++) {
      try { return await task(); }
      catch (e) {
        if ((e && e.cancelled) || attempt >= retryCount || !shouldRetry(e)) throw e;
        // 429/503 响应若带了 Retry-After（delta 秒）就听服务端的，封顶 30 秒；
        // 没有或不合法才用固定间隔，防网关/图床明确说了要等却还在 1 秒后撞上去。
        const after = Number(e && e.retryAfterMs);
        const delay = Number.isFinite(after) && after > 0 ? Math.min(after, 30000) : delayMs;
        await wait(delay);
      }
    }
  }

  function createRequestTracker() {
    const active = new Set();
    return {
      track(request) {
        active.add(request);
        return () => active.delete(request);
      },
      abortAll() {
        const requests = [...active];
        active.clear();
        for (const request of requests) request.abort();
      },
    };
  }

  // check 返回 null 表示仍在处理，否则返回最终结果。单次请求最多等 30 秒，
  // 但最后一次只能使用总截止时间内剩余的时长。
  // 剩余不足一次请求的预算时直接判总超时：那时发出去请求几乎必然被掐断，报出来的是
  // 「请求超过 1 秒没有响应」，而真实原因只是轮询总时限已经耗尽。
  const POLL_MIN_REQUEST_MS = 1000;

  async function pollBeforeDeadline(check, wait, now, deadline) {
    while (true) {
      const beforeWait = deadline - now();
      if (beforeWait <= 0) return null;
      await wait(Math.min(1000, beforeWait));

      const remaining = deadline - now();
      if (remaining < POLL_MIN_REQUEST_MS) return null;
      const result = await check(Math.min(30000, remaining));
      if (result !== null) return result;
    }
  }

  async function withCleanup(task, cleanup) {
    try { return await task(); }
    finally { cleanup(); }
  }

  // 云空间分页必须读到 has_more=false 才算完整。游标缺失、重复或页数异常时抛错，
  // 不能把已经读到的部分误当成完整列表交给后续导出。
  async function collectDrivePages(fetchPage, maxPages = 1000) {
    const out = [];
    const seenLabels = new Set();
    let label = '';

    for (let page = 0; page < maxPages; page++) {
      const data = await fetchPage(label);
      const nodes = (data.entities && data.entities.nodes) || {};
      for (const token of data.node_list || []) if (nodes[token]) out.push(nodes[token]);
      if (!data.has_more) return out;

      const nextLabel = String(data.last_label || '');
      if (!nextLabel || nextLabel === label || seenLabels.has(nextLabel)) {
        const error = new Error('drive pagination cursor did not advance');
        error.code = 'drive_pagination_cursor';
        throw error;
      }
      seenLabels.add(nextLabel);
      label = nextLabel;
    }

    const error = new Error(`drive pagination exceeded ${maxPages} pages`);
    error.code = 'drive_pagination_limit';
    throw error;
  }

  const isRetryableDownloadStatus = (status) =>
    status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);

  // 同批次内重名时追加 (2)(3)…。只动最后一段的文件名 —— 带目录时若目录名里有点，
  // 直接找最后一个 '.' 会把后缀插进目录名里去。
  function uniqueName(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    const slash = name.lastIndexOf('/');
    const dir = slash >= 0 ? name.slice(0, slash + 1) : '';
    const base = name.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 2; ; i++) {
      const candidate = `${dir}${stem} (${i})${ext}`;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
  }

  // 图片目录去重。不能复用 uniqueName：目录没有扩展名，而 uniqueName 会把最后一个 '.'
  // 之后整段当扩展名（标题里的点很常见，如「v1.2 方案」），序号会插进名字中间。
  // 同名文档共用 assets 目录时，zip 里会出现重复条目，解压后一篇的图覆盖另一篇
  // —— 所以目录也必须唯一。
  function uniqueDir(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    for (let i = 2; ; i++) {
      const candidate = `${name}-${i}`;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
  }

  // {node, children:[…]} 的树 → 深度优先扁平列表，带 depth 与祖先标题路径。
  // 深度优先保证：某项的后代 = 它后面 depth 更大的连续一段（面板的级联勾选靠这个）。
  function flatten(roots, depth = 0, path = [], out = []) {
    for (const item of roots) {
      out.push({ node: item.node, depth, path });
      if (item.children && item.children.length) {
        flatten(item.children, depth + 1, path.concat(item.node.title), out);
      }
    }
    return out;
  }

  // 空间根是个「虚拟节点」：get_node 打它一律返回 code 2，但 get_node_child 能列出它的子节点。
  // 所以沿 parent_wiki_token 往上爬，爬到 fetchNode 返回 null 为止 —— 那个 token 就是虚拟根。
  // fetchNode(token, soft) 约定：成功返回节点；soft 且接口报错时返回 null。
  // rootNode 非 null 表示根本身是个真实节点（它自己也该出现在树里）。
  async function findSpaceRoot(startToken, fetchNode) {
    let node = await fetchNode(startToken);
    const spaceId = node.space_id;
    for (let i = 0; i < 64; i++) {
      const parent = node.parent_wiki_token;
      if (!parent) break;
      const next = await fetchNode(parent, true);
      if (!next) return { spaceId, rootToken: parent, rootNode: null };
      node = next;
    }
    return { spaceId, rootToken: node.wiki_token, rootNode: node };
  }

  // 导出的 md 里，图片是跨域的 authcode 链接，code 里带 ~24h 有效期，
  // 放着不动图就会全部失效。所以「图片转本地」要把它们抓到本地再改写链接。
  // 图床域名带区域后缀：飞书是 internal-api-drive-stream.feishu.cn，
  // Lark 是 internal-api-drive-stream-jp.larksuite.com（两边都实测过）。
  const IMG_RE = /!\[([^\]]*)\]\((https:\/\/[^)\s]*\.(?:feishu\.cn|larksuite\.com)\/[^)\s]+)\)/g;
  const EXT_BY_MIME = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  };

  const imageExt = (mime) => EXT_BY_MIME[String(mime || '').split(';')[0].trim()] || 'png';

  function mdImageUrls(md) {
    return [...new Set([...String(md).matchAll(IMG_RE)].map((m) => m[2]))];
  }

  // mapping: 原始 URL -> zip 内相对路径。没抓下来的原样留着，不要把链接改瞎。
  function rewriteImageLinks(md, mapping) {
    return String(md).replace(IMG_RE, (whole, alt, url) =>
      (mapping[url] ? `![${alt}](${mapping[url]})` : whole));
  }

  // ── zip（STORE，不压缩）──
  // 浏览器没有原生 zip：CompressionStream 只有 deflate，不含 zip 容器。无构建步骤下
  // 引 JSZip 意味着往仓库塞一个 ~100KB 的 min.js。而导出物 docx/pdf/xlsx/png 本身
  // 已是压缩格式，STORE 的体积损失可以忽略，md 又很小 —— 不值得为它加依赖。
  // ponytail: 不支持 zip64，超过 4GB 或 65535 个文件会坏；真到那个量级再说。
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // entries: [{path, blob, crc, size}] → BlobPart 数组。
  // 文件内容始终以 Blob 形式传递，不进 JS 堆 —— 几百 MB 的批次靠这个撑住。
  function zipParts(entries, date = new Date()) {
    const enc = new TextEncoder();
    const uint16Max = 0xffff;
    const uint32Max = 0xffffffff;
    const limitError = (detail) => {
      const error = new RangeError(`ZIP32 limit exceeded: ${detail}`);
      error.code = 'zip_limit';
      return error;
    };
    if (entries.length > uint16Max) throw limitError('entry count');

    // 先校验再写任何头部，避免 DataView 将超范围数值静默截断成损坏的 ZIP。
    const prepared = [];
    let checkedOffset = 0;
    let checkedCentralSize = 0;
    for (const entry of entries) {
      const name = enc.encode(entry.path);
      if (name.length > uint16Max) throw limitError('file name');
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > uint32Max) {
        throw limitError('file size');
      }
      checkedOffset += 30 + name.length + entry.size;
      if (checkedOffset > uint32Max) throw limitError('central directory offset');
      checkedCentralSize += 46 + name.length;
      if (checkedCentralSize > uint32Max) throw limitError('central directory size');
      prepared.push({ entry, name });
    }
    if (checkedOffset + checkedCentralSize + 22 > uint32Max) throw limitError('archive size');

    const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
    const parts = [];
    const central = [];
    let offset = 0;

    for (const { entry: e, name } of prepared) {
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // 文件名是 UTF-8
      local.setUint16(8, 0, true);      // STORE
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, e.crc, true);
      local.setUint32(18, e.size, true);
      local.setUint32(22, e.size, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, e.blob);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, dosTime, true);
      cd.setUint16(14, dosDate, true);
      cd.setUint32(16, e.crc, true);
      cd.setUint32(20, e.size, true);
      cd.setUint32(24, e.size, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd.buffer, name);

      offset += 30 + name.length + e.size;
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, checkedCentralSize, true);
    eocd.setUint32(16, offset, true);
    return parts.concat(central, [eocd.buffer]);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      pickFormat, sanitizeName, uniqueName, uniqueDir, flatten, findSpaceRoot, TYPES,
      crc32, zipParts, imageExt, mdImageUrls, rewriteImageLinks, safeSlug, buildStem, descendantEnd,
      buildDirPrefix, nextSeq, etaSeconds, isFolder, asNode, editTime, withExt, addTokenToFilename,
      formatSize, readCookie,
      wikiTokenFromPath, driveFolderTokenFromPath, sourceForPath,
      parseDocumentUrl, parseUrlText, buildDirectNode, resolveUrlItem,
      normalizeExportResult, titleFromExportResult, titleFromDownload, filenameFromContentDisposition,
      requestAttachmentFilename,
      copyLogText, appendSourceUrl, retryAsync, withCleanup,
      createRequestTracker, pollBeforeDeadline,
      isRetryableDownloadStatus, sourceUrlForNode, collectDrivePages,
    };
  }
  if (typeof document === 'undefined') return; // Node 里跑测试时到此为止

  // ───────────────────────── 通信 ─────────────────────────

  const REPO = 'https://github.com/rockbenben/feishu-lark-batch-export';
  const API = '/space/api';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // URL 列表里每行 wiki 都要单独打一次 get_node，行与行之间留的间隔。
  const URL_RESOLVE_DELAY_MS = 400;
  const API_TIMEOUT_MS = 30000;
  const activeRequests = createRequestTracker();
  let fileNameRequestSeq = 0;

  // 取错这个 cookie 的症状是「文档能列出来、一篇也导不出」：列表全是 GET，不带这个头。
  const csrf = () => readCookie(document.cookie, '_csrf_token');

  function cancelledError() {
    const error = new Error(t('stopped'));
    error.cancelled = true;
    error.retryable = false;
    return error;
  }

  // 重试间隔也要能被「停止」打断：429 带 Retry-After 时这里最长等 30 秒，等完才发现
  // 已经点了停止，等于按钮白按。retryAsync 保持纯函数，停止判断放在注入的 wait 里。
  const interruptibleWait = (ms) =>
    (stopped ? Promise.reject(cancelledError()) : sleep(ms));

  // 无回调的 sendMessage 把失败留在 chrome.runtime.lastError 里，只在控制台刷一条
  // "Unchecked runtime.lastError"。回读 lastError 才能把失败变成能 catch 的拒绝。
  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message || 'extension message failed'));
        else resolve(response);
      });
    });
  }

  // ── 文案 ──
  // 默认跟随浏览器语言（chrome.i18n）。手动指定语言时只能自己把 messages.json 读进来
  // 解析 —— chrome.i18n 没有运行时覆盖 locale 的 API。
  // 注意：扩展名、描述、工具栏 tooltip 走 manifest 的 __MSG__，永远跟浏览器语言，
  // 切不了。那是 chrome.i18n 的硬限制，不是这里少写了代码。
  const LANGS = ['zh_CN', 'en'];
  let MSG = null; // null = 跟随浏览器

  function t(key, ...subs) {
    if (MSG && MSG[key]) {
      return String(MSG[key].message).replace(/\$(\d)/g, (_, n) => String(subs[n - 1] ?? ''));
    }
    // 扩展被重新加载后（手动重载，或商店版静默自动更新），已打开的页面里这份 content
    // script 的 context 已失效，chrome.i18n.getMessage 会抛 Extension context
    // invalidated。取不到文案就退回 key：界面难看一点，但这函数还用在拼错误消息上，
    // 让它抛等于错误处理本身也会炸，正在跑的队列会每一篇都报这个。
    try {
      return (typeof chrome !== 'undefined' && chrome.i18n
        && chrome.i18n.getMessage(key, subs.map(String))) || key;
    } catch (e) { return key; }
  }

  function loadLocale(lang) {
    if (!LANGS.includes(lang)) { MSG = null; return Promise.resolve(); }
    return new Promise((resolve) => {
      // 同上：context 失效时 sendMessage 直接抛，不是走 lastError。
      try {
        chrome.runtime.sendMessage({ type: 'fbe-locale', lang }, (res) => {
          void chrome.runtime.lastError; // service worker 没起来时别往控制台喷
          MSG = res || null;             // 读不到就退回浏览器语言，别把界面变成一堆 key
          resolve();
        });
      } catch (e) { MSG = null; resolve(); }
    });
  }

  const typeName = (objType) =>
    (TYPES[objType] ? t(TYPES[objType].key) : t('typeUnknown', objType));

  // 飞书的 policy-sdk 劫持了 window.fetch，自发的 fetch 一律 Failed to fetch。必须用 XHR。
  function xhr(method, url, body, timeoutMs = API_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url, true);
      x.withCredentials = true;
      x.timeout = timeoutMs;
      if (body) {
        x.setRequestHeader('Content-Type', 'application/json');
        x.setRequestHeader('x-csrftoken', csrf());
      }
      const release = activeRequests.track(x);
      let settled = false;
      const settle = (complete) => {
        if (settled) return;
        settled = true;
        release();
        complete();
      };
      x.onload = () => settle(() => {
        try { resolve(JSON.parse(x.responseText)); }
        catch (e) {
          // 带上响应体。业务错误是 HTTP 200 + JSON 里的 code，走不到这儿；
          // 走到这儿说明被网关挡了，而理由只写在这段纯文本里（比如 csrf token error）。
          // 光报状态码的话，权限、CSRF、限频看上去一模一样。
          reject(new Error(t('errNotJson', x.status,
            (x.responseText || '').replace(/\s+/g, ' ').trim().slice(0, 200))));
        }
      });
      x.onerror = () => settle(() => reject(new Error(t('errNetwork'))));
      x.ontimeout = () => settle(() => {
        const error = new Error(t('errRequestTimeout', Math.ceil(timeoutMs / 1000)));
        error.timedOut = true;
        reject(error);
      });
      x.onabort = () => settle(() => reject(cancelledError()));
      try { x.send(body ? JSON.stringify(body) : null); }
      catch (error) { settle(() => reject(error)); }
    });
  }

  // soft=true 时接口报错返回 null（用来探测「这个 token 是不是虚拟根」），网络错误照样抛。
  async function getNode(wikiToken, soft) {
    const r = await xhr('GET', `${API}/wiki/v2/tree/get_node/?wiki_token=${wikiToken}`);
    if (r.code !== 0) {
      if (soft) return null;
      throw new Error(t('errReadNode', `${r.code} ${r.msg || ''}`));
    }
    return r.data;
  }

  function urlErrorText(reason) {
    if (reason === 'protocol') return t('errUrlProtocol');
    if (reason === 'origin') return t('errUrlOrigin');
    if (reason === 'path') return t('errUrlPath');
    if (reason === 'token') return t('errUrlToken');
    return t('errUrlInvalid');
  }

  async function scanUrls(file, onProgress) {
    const parsed = parseUrlText(await file.text(), location.origin);
    for (const e of parsed.errors) {
      log(appendSourceUrl(t('urlInvalidLine', e.lineNumber, urlErrorText(e.reason)), e.raw));
    }
    // 重复项前面没有逐行报过（不像无效行），这里汇总一次，免得 20 行变成 18 篇没人知道
    if (parsed.duplicates.length) {
      log(t('urlDeduped', parsed.duplicates.length,
        parsed.duplicates.slice(0, 5).map((d) => d.lineNumber).join(', ')));
    }
    if (!parsed.items.length) throw new Error(t('errNoValidUrl'));

    const roots = [];
    for (let i = 0; i < parsed.items.length; i++) {
      const item = parsed.items[i];
      onProgress(i, parsed.items.length);
      try {
        const node = await resolveUrlItem(item, getNode);
        roots.push({ node, children: [] });
      } catch (e) {
        log(appendSourceUrl(t('urlReadFailed', item.lineNumber, item.urlToken, e.message), item.url));
      }
      // wiki 行每行都要打一次 get_node 做 token 转换；大批背靠背请求容易撞限频。
      // 直解文档不发网络请求，不用等。失败也等 —— 限频往往正是失败原因。
      if (item.kind === 'wiki') await sleep(URL_RESOLVE_DELAY_MS);
    }
    onProgress(parsed.items.length, parsed.items.length);
    // 逐行错误前面已经报过；但一个都没读出来时不能走成功分支说「列出 0 个链接」，
    // 那看起来像列表本来就是空的。
    if (!roots.length) throw new Error(t('errUrlsAllFailed'));
    return roots;
  }

  // ── 云空间（非知识库）──
  // 实测：参数越少越好，加 type/rank 那些反而 500。node_list 才是真正的子项，
  // entities.nodes 里还混着父节点自己。分页靠 has_more + last_label。
  async function driveList(path, extra = '') {
    try {
      return await collectDrivePages(async (label) => {
        const url = `${API}/explorer/v3/${path}?length=50${extra}`
          + (label ? `&last_label=${encodeURIComponent(label)}` : '');
        const r = await xhr('GET', url);
        if (r.code !== 0) throw new Error(t('errReadDrive', `${r.code} ${r.msg || ''}`));
        return r.data || {};
      });
    } catch (error) {
      if (error.code === 'drive_pagination_cursor') throw new Error(t('errDrivePaginationCursor'));
      if (error.code === 'drive_pagination_limit') throw new Error(t('errDrivePaginationLimit'));
      throw error;
    }
  }

  async function getChildren(spaceId, wikiToken) {
    const url = `${API}/wiki/v2/tree/get_node_child/?space_id=${spaceId}&wiki_token=${wikiToken}`
      + '&expand_shortcut=true&exclude_fields=5&is_pre_heating=false';
    const r = await xhr('GET', url);
    if (r.code !== 0) throw new Error(t('errReadChildren', `${r.code} ${r.msg || ''}`));
    return (r.data && r.data[wikiToken]) || [];
  }

  // 返回下载信息。ext 为 null 表示附件直下，文件名稍后从下载响应头取得。
  async function exportOne(node, fmt, needComment) {
    if (fmt.api === null) return { url: `${API}/box/stream/download/all/${node.obj_token}`, ext: null };

    const created = await xhr('POST', `${API}/export/create/`, {
      token: node.obj_token, type: fmt.api, file_extension: fmt.ext,
      event_source: '1', need_comment: !!needComment, sub_id: '',
    });
    if (created.code !== 0) throw new Error(t('errCreate', `${created.code} ${created.msg || ''}`));

    const ticket = created.data.ticket;
    const query = `${API}/export/result/${ticket}?token=${node.obj_token}&type=${fmt.api}`;
    const ready = await pollBeforeDeadline(async (timeoutMs) => {
      if (stopped) throw cancelledError();
      const r = await xhr('GET', query, null, timeoutMs);
      if (r.code !== 0) throw new Error(t('errQuery', `${r.code} ${r.msg || ''}`));
      const res = (r.data && r.data.result) || {};
      if (res.job_status === 0) {
        const result = normalizeExportResult(res, fmt.ext);
        return {
          url: `${API}/box/stream/download/all/${result.fileToken}`,
          ext: result.ext,
          fileName: result.fileName,
        };
      }
      // 1/2 = 排队中/处理中；其余非零一律当失败
      if (res.job_status !== 1 && res.job_status !== 2) {
        throw new Error(res.job_error_msg || t('errExport', res.job_status));
      }
      return null;
    }, sleep, Date.now, Date.now() + 120000);
    if (!ready) throw new Error(t('errTimeout'));
    return ready;
  }

  // 图片那些 authcode 链接实测必须 withCredentials=false —— 带 cookie 会被 CORS 拒。
  function fetchBlob(url, withCredentials = true, timeoutMs = 0) {
    if (stopped) return Promise.reject(cancelledError());
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.withCredentials = withCredentials;
      x.timeout = timeoutMs;
      x.responseType = 'blob';
      const release = activeRequests.track(x);
      let settled = false;
      const settle = (complete) => {
        if (settled) return;
        settled = true;
        release();
        complete();
      };
      const fail = (message, retryable) => {
        const error = new Error(message);
        error.retryable = retryable;
        // Retry-After 只认 delta 秒（HTTP-date 形式飞书不用）；值非法就忽略。
        if (retryable) {
          const after = Number(x.getResponseHeader('Retry-After'));
          if (Number.isFinite(after) && after > 0) error.retryAfterMs = Math.min(after, 30) * 1000;
        }
        settle(() => reject(error));
      };
      x.onload = () => (x.status === 200
        ? settle(() => resolve(x.response))
        : fail(`HTTP ${x.status}`, isRetryableDownloadStatus(x.status)));
      x.onerror = () => fail(t('errNetwork'), true);
      x.ontimeout = () => fail(t('errNetwork'), true);
      x.onabort = () => settle(() => reject(cancelledError()));
      try { x.send(); }
      catch (error) { settle(() => reject(error)); }
    });
  }

  // 读一遍算 CRC，然后丢掉 ArrayBuffer，只留 Blob（浏览器管，可落盘）。
  async function toEntry(path, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { path, blob, crc: crc32(bytes), size: bytes.length };
  }

  // 图片放在 md 同级的 assets/ 下，所以 md 里写的相对链接跟目录深度无关，
  // 开不开「保留目录结构」都不用改写成 ../../ 那种东西。dir 由调用方用
  // uniqueDir 保证同批次唯一，重名文档不能共用一个图片目录。
  async function localizeImages(md, dir, dirPrefix) {
    const urls = mdImageUrls(md);
    const mapping = {};   // url → md 里的相对链接
    const entries = [];
    for (const url of urls) {
      try {
        // 首次失败后再试两次；重试本身不写日志，三次都失败才由外层 catch 报一次。
        const blob = await retryAsync(
          () => fetchBlob(url, false, 15000),
          2,
          interruptibleWait,
          1000,
        );
        const rel = `assets/${dir}/${String(entries.length + 1).padStart(3, '0')}.${imageExt(blob.type)}`;
        mapping[url] = rel;
        entries.push(await toEntry(dirPrefix + rel, blob));
      } catch (e) {
        if (e && e.cancelled) throw e;
        log(appendSourceUrl(t('imgFailed', e.message), url));
      }
    }
    return { md: rewriteImageLinks(md, mapping), entries };
  }

  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ───────────────────────── 面板 ─────────────────────────

  let rows = [];      // flatten() 的结果
  let failed = [];
  let stopped = false;
  let running = false;
  let selectedUrlFile = null;
  let copyFeedbackTimer = null;
  // 上次成功列出的是哪个页面。打开面板时落在目标明确的页面（知识库文档页/文件夹页）
  // 就自动列一次，同一页面不重复列；「我的云空间」意图不明确，不自动跑。
  let listedFor = null;

  const $ = (id) => document.getElementById(id);

  // 失败/跳过行在两种语言里都以 ✗ 或 − 开头（见 _locales 的 itemFailed /
  // urlInvalidLine 等）。出现这种行时让复制按钮常驻，普通的「列出 N 项」不值得一个按钮。
  const LOG_TOOLS_ON_RE = /[✗−]/;

  function log(msg) {
    const el = $('fbe-log');
    const wrap = $('fbe-log-wrap');
    wrap.hidden = false; // 没话说的时候不占地方
    el.textContent += (el.textContent ? '\n' : '') + msg;
    if (LOG_TOOLS_ON_RE.test(msg)) wrap.classList.add('fbe-log-tools-on');
    el.scrollTop = el.scrollHeight;
  }

  async function copyCurrentLog() {
    const button = $('fbe-log-copy');
    button.disabled = true;
    clearTimeout(copyFeedbackTimer);
    try {
      const copied = await copyLogText(
        $('fbe-log').textContent,
        (text) => navigator.clipboard.writeText(text),
      );
      button.textContent = copied ? t('copyLogDone') : t('copyLogFailed');
      button.title = button.textContent;
    } catch (e) {
      button.textContent = t('copyLogFailed');
      button.title = `${t('copyLogFailed')}: ${e.message}`;
    } finally {
      button.disabled = false;
      copyFeedbackTimer = setTimeout(() => {
        if (!button.isConnected) return;
        button.textContent = t('copyLog');
        button.title = t('copyLog');
      }, 1600);
    }
  }

  function setProgress(done, total, elapsedMs) {
    const bar = $('fbe-progress');
    if (total <= 0) { bar.hidden = true; return; }
    bar.hidden = false;
    const left = etaSeconds(done, elapsedMs, total);
    const eta = left === null ? ''
      : (left < 60 ? t('etaSec', left) : t('etaMin', Math.round(left / 60)));
    $('fbe-progress-text').textContent = `${done} / ${total}${eta ? ` · ${eta}` : ''}`;
    $('fbe-progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
  }

  function checkboxes() {
    return Array.from($('fbe-tree').querySelectorAll('input[type=checkbox]'));
  }

  function refreshCount() {
    const n = checkboxes().filter((c) => c.checked).length;
    $('fbe-count').textContent = rows.length ? t('selectedCount', n, rows.length) : '';
    $('fbe-start').disabled = running || n === 0;
    // 主按钮跟着当前这一步走：还没列出东西时，该点的是「列出文档」；
    // 列出来了，重心才移到「开始导出」。任何时刻只有一个显眼的下一步。
    $('fbe-scan').classList.toggle('fbe-btn--go', rows.length === 0 && !running);
    // 还没列出东西之前，那几个只对列表生效的控件不该看起来能用
    $('fbe-all').disabled = rows.length === 0;
    $('fbe-since').disabled = rows.length === 0;
  }

  // 列表为空时，让位给一句「接下来做什么」，而不是留一片空白
  function showEmpty(text) {
    $('fbe-tree').hidden = !!text;
    $('fbe-empty').hidden = !text;
    if (text) $('fbe-empty').textContent = text;
  }

  // 过滤只管显示，不碰勾选状态 —— 行是 CSS 隐藏的，checkbox 还在 DOM 里，
  // checkboxes() 与 rows 的下标对应关系因此不受影响。
  function applyFilter() {
    const q = $('fbe-q').value.trim().toLowerCase();
    const lines = Array.from($('fbe-tree').children);
    if (!q) {
      lines.forEach((l) => { l.hidden = false; });
      showEmpty(rows.length ? '' : t('emptyInvite'));
      return;
    }

    const show = rows.map((r) => String(r.node.title || '').toLowerCase().includes(q));
    // 命中项的祖先也要留着，否则过滤完只剩一堆没有上下文的孤立标题
    for (let i = rows.length - 1; i >= 0; i--) {
      if (show[i]) continue;
      for (let j = i + 1, end = descendantEnd(rows, i); j < end; j++) {
        if (show[j]) { show[i] = true; break; }
      }
    }
    lines.forEach((l, i) => { l.hidden = !show[i]; });
    showEmpty(show.some(Boolean) ? '' : t('emptyNoMatch', $('fbe-q').value.trim()));
  }

  // checked 永远精确等于「这篇会被导出」；indeterminate 只是「我自己没选、但下面还有货」
  // 的提示。两者语义不混，所以收集选中项的逻辑不受影响。
  function refreshMarks() {
    const boxes = checkboxes();
    for (let i = 0; i < rows.length; i++) {
      if (boxes[i].checked) { boxes[i].indeterminate = false; continue; }
      let any = false;
      for (let j = i + 1, end = descendantEnd(rows, i); j < end; j++) {
        if (boxes[j].checked) { any = true; break; }
      }
      boxes[i].indeterminate = any;
    }
  }

  function renderTree() {
    const tree = $('fbe-tree');
    tree.textContent = '';
    rows.forEach((row, i) => {
      const line = document.createElement('div');
      line.style.paddingLeft = `${14 + row.depth * 16}px`;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.i = String(i);
      // 导不出来的类型（思维笔记）直接不给勾 —— 让人选中一个注定被跳过的东西，
      // 是把失败推迟到导出之后才告诉他。pickFormat 返回 null 只跟类型有关，
      // 跟当前选的格式无关，所以这里就能定。
      if (!pickFormat(row.node.obj_type, 'auto')) {
        cb.disabled = true;
        line.classList.add('fbe-dead');
        line.title = t('notExportable', typeName(row.node.obj_type));
      }
      // 标题左、类型右，两列对齐 —— 这才让它读起来像一张装箱单，而不是文件选择器
      const label = document.createElement('label');
      label.className = 'fbe-name';
      label.textContent = row.node.title || t('untitled');
      const tag = document.createElement('em');
      tag.className = 'fbe-kind';
      tag.textContent = row.node.has_child && !TYPES[row.node.obj_type]
        ? t('typeFolder') : typeName(row.node.obj_type);
      // 默认连带子孙（「导出整个目录」是最常见的操作）；按住 Alt 只作用于这一条，
      // 于是「只要目录本身这篇」和「取消目录但保留已勾的子项」都是单次操作。
      const toggle = (cascade) => {
        if (cascade) {
          const boxes = checkboxes();
          // 禁用的（导不出的类型）不能被级联带上 —— 程序化赋值绕得过 disabled
          for (let j = i + 1, end = descendantEnd(rows, i); j < end; j++) {
            if (!boxes[j].disabled) boxes[j].checked = cb.checked;
          }
        }
        refreshMarks();
        refreshCount();
      };
      cb.onclick = (e) => toggle(!e.altKey);
      label.onclick = (e) => { cb.checked = !cb.checked; toggle(!e.altKey); };
      line.append(cb, label, tag);
      tree.appendChild(line);
    });
    applyFilter();
    refreshCount();
  }

  // 按修改时间批量勾选，做增量备份用。这是个动作，不是过滤器 —— 勾完就随你改。
  function selectRecent(days) {
    if (!days) return;
    const cutoff = Date.now() / 1000 - days * 86400;
    const boxes = checkboxes();
    let hit = 0;
    rows.forEach((row, i) => {
      boxes[i].checked = !boxes[i].disabled && editTime(row.node) >= cutoff;
      if (boxes[i].checked) hit++;
    });
    refreshMarks();
    refreshCount();
    log(t('selectedRecent', days, hit));
  }

  // ── 设置持久化 ──
  // fbe-src 不存：它该跟着当前页面走，存下来反而会在换页后是错的。
  // fbe-since 不存：那是个一次性动作，不是状态。
  const SETTINGS_KEY = 'fbe-settings';
  const SETTING_IDS = [
    'fbe-lang', 'fbe-fmt', 'fbe-img', 'fbe-comment', 'fbe-num', 'fbe-parent', 'fbe-token', 'fbe-dirs',
  ];

  // 语言得在建面板之前就知道 —— 面板的文案是建的时候一次性写死的。
  function readSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
  }

  function loadSettings() {
    const saved = readSettings();
    for (const id of SETTING_IDS) {
      if (!(id in saved)) continue;
      const el = $(id);
      if (el.type === 'checkbox') el.checked = !!saved[id];
      else { el.value = saved[id]; if (!el.value) el.value = 'auto'; } // 存的是已经删掉的选项时兜底
    }
  }

  function saveSettings() {
    const out = readSettings(); // 先读回来：里面还有不是控件的键（按钮位置），别覆盖没了
    for (const id of SETTING_IDS) {
      const el = $(id);
      out[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(out)); } catch (e) { /* 无痕模式等，忽略 */ }
  }

  async function scanWiki(onFolder, onSkip) {
    const token = wikiTokenFromPath(location.pathname);
    if (!token) {
      // 在 /wiki/ 下却取不到 token ⇒ 停在知识库首页或功能页，不是某一篇文档。
      // 这两种情况该做的下一步不同，别混成一句话。
      if (/\/wiki\//.test(location.pathname)) throw new Error(t('errWikiNotDoc'));
      const right = sourceForPath(location.pathname) === 'folder' ? t('srcFolder') : t('srcDrive');
      throw new Error(t('errNotWiki', right));
    }

    const { spaceId, rootToken, rootNode } = await findSpaceRoot(token, getNode);
    const walk = async (node) => {
      const item = {
        node: {
          ...node,
          url_token: node.wiki_token,
          source_url: sourceUrlForNode(location.origin, node, 'wiki'),
        },
        children: [],
      };
      if (node.has_child) {
        onFolder();
        let kids;
        try {
          kids = await getChildren(spaceId, node.wiki_token);
        } catch (e) { onSkip(node, e); return item; }
        for (const child of kids) item.children.push(await walk(child));
      }
      return item;
    };
    const tops = rootNode ? [rootNode] : await getChildren(spaceId, rootToken);
    const items = [];
    for (const node of tops) items.push(await walk(node));
    return items;
  }

  // 云空间往下一层永远是同一个接口，所以两个云空间来源共用这个递归。
  // onSkip：某个子文件夹列不开时回调。共享文件夹里各子目录权限可能不一致，
  // 一个打不开就把整棵树清零不对 —— 导出队列对单篇失败也是跳过继续，扫描同理。
  // 起点（顶层）列不开不在这儿兜底：那说明整个来源就不可用，该直接报错。
  function driveWalker(onFolder, onSkip) {
    const walk = async (node) => {
      const item = { node, children: [] };
      if (node.has_child) {
        onFolder();
        let kids;
        try {
          kids = await driveList('children/list/', `&token=${node.wiki_token}`);
        } catch (e) { onSkip(node, e); return item; }
        for (const child of kids) item.children.push(await walk(asNode(child, location.origin)));
      }
      return item;
    };
    return walk;
  }

  async function scanDrive(onFolder, onSkip) {
    const walk = driveWalker(onFolder, onSkip);
    // 根目录的文件夹和文档分两个接口，合起来才是完整的一层
    const roots = [
      ...await driveList('my_space/folder/'),
      ...await driveList('my_space/obj/'),
    ];
    const items = [];
    for (const n of roots) items.push(await walk(asNode(n, location.origin)));
    return items;
  }

  // 我正在看的这个文件夹。跟知识库那个来源对称 —— 都从你当前所在的位置往下扫。
  // my_space 那个来源只看你自己空间的根，别人分享给你的文件夹（哪怕你是管理员）
  // 压根不在里面，所以没有这个来源就没法导出共享文件夹。
  // 顶层直接用这个文件夹的子项：文件夹本身是导出的起点，不是要导的文档。
  async function scanFolder(onFolder, onSkip) {
    const token = driveFolderTokenFromPath(location.pathname);
    if (!token) {
      const right = sourceForPath(location.pathname) === 'wiki' ? t('srcWiki') : t('srcDrive');
      throw new Error(t('errNotFolder', right));
    }
    const walk = driveWalker(onFolder, onSkip);
    const items = [];
    for (const n of await driveList('children/list/', `&token=${token}`)) {
      items.push(await walk(asNode(n, location.origin)));
    }
    return items;
  }

  async function scan() {
    const button = $('fbe-scan');
    button.disabled = true;
    $('fbe-log').textContent = '';
    $('fbe-log-wrap').hidden = true;
    $('fbe-log-wrap').classList.remove('fbe-log-tools-on');
    showEmpty(t('listing'));
    try {
      let folders = 0;
      const onFolder = () => { if (++folders % 10 === 0) showEmpty(t('listExpanded', folders)); };
      // 子文件夹打不开只跳过它那棵子树，名字记下来列完报给用户 —— 备份工具最怕
      // 静默缺一块，也不能因为一块没权限就整块都不给。
      const skips = [];
      const onSkip = (node, e) => skips.push(`${node.title}: ${e.message}`);
      const srcSel = $('fbe-src');
      let src = srcSel.value;
      // 面板开着时站内跳转不会重算下拉，点「列出文档」时再兜一次：选的是 wiki/folder
      // 而当前页面根本不匹配，这两种是必错（drive 任何页面都能用，不拦），就切到当前
      // 页面对应的来源。下拉同步过去，日志说一声 —— 让人看到跑的就是显示的那个。
      const matched = sourceForPath(location.pathname);
      if (src !== 'urls'
        && ((src === 'wiki' && matched !== 'wiki') || (src === 'folder' && matched !== 'folder'))) {
        src = matched;
        srcSel.value = matched;
        updateSourceControls();
        const name = matched === 'wiki' ? t('srcWiki') : matched === 'folder' ? t('srcFolder') : t('srcDrive');
        log(t('srcAutoSwitched', name));
      }
      let items;
      if (src === 'urls') {
        if (!selectedUrlFile) throw new Error(t('errNoUrlFile'));
        items = await scanUrls(selectedUrlFile, (done, total) => {
          showEmpty(t('urlChecking', done, total));
        });
      } else {
        const scanner = src === 'drive' ? scanDrive : (src === 'folder' ? scanFolder : scanWiki);
        items = await scanner(onFolder, onSkip);
      }
      rows = flatten(items);
      listedFor = src === 'urls' ? 'urls' : location.pathname;
      renderTree();
      if (src === 'urls') log(t('urlListDone', rows.length));
      else log(t('listDone', rows.length, folders));
      if (skips.length) log(t('listSkipped', skips.length, skips.slice(0, 5).join('; ')));
    } catch (e) {
      rows = [];
      renderTree();
      // 原因写进日志（内层消息本身就说清了发生什么，外面别再套一层「没能……」），
      // 空白区换成「接下来能试什么」—— 失败之后那块地方不该还在念通用的开场白。
      log(t('listFailed', e.message));
      showEmpty(t('emptyFailed'));
    } finally {
      button.disabled = false;
    }
  }

  function finishRun(items, startedAt) {
    running = false;
    setProgress(items.length, items.length, Date.now() - startedAt);
    $('fbe-stop').hidden = true;
    $('fbe-scan').disabled = false;
    $('fbe-retry').hidden = failed.length === 0;
    $('fbe-retry').textContent = t('btnRetry', failed.length); // 说清楚要重试几篇
    refreshCount();
  }

  async function run(items, startedAt = Date.now()) {
    running = true;
    stopped = false;
    failed = [];
    $('fbe-stop').hidden = false;
    $('fbe-stop').disabled = false;
    $('fbe-retry').hidden = true;
    $('fbe-scan').disabled = true;
    refreshCount();

    const want = $('fbe-fmt').value;
    // 图片本地化跟格式选择解耦：只要这一篇最终产出的是 md 就抓图，
    // 所以「自动」模式下文档给 md 时也照样带图。docx/pdf/xlsx 是二进制、
    // 图片已内嵌在文件里，没有外链可转，这个开关对它们无意义。
    const withImages = $('fbe-img').checked;
    const nameOpts = {
      number: $('fbe-num').checked,
      parent: $('fbe-parent').checked,
      token: $('fbe-token').checked,
    };
    const keepTree = $('fbe-dirs').checked;
    const needComment = $('fbe-comment').checked;
    const used = new Set();
    const usedImgDirs = new Set();
    const seq = new Map();
    const files = [];   // {path, blob, crc, size}

    for (let i = 0; i < items.length; i++) {
      if (stopped) { log(t('stopped')); break; }
      const { node, path } = items[i];
      setProgress(i, items.length, Date.now() - startedAt);
      try {
        const fmt = pickFormat(node.obj_type, want);
        if (!fmt) {
          log(appendSourceUrl(t('skipUnsupported', node.title, typeName(node.obj_type)), node.source_url));
          continue;
        }

        const result = await exportOne(node, fmt, needComment);
        const dirPrefix = buildDirPrefix(path, keepTree);
        const index = nextSeq(seq, dirPrefix);
        let responseFileName = '';
        if (result.ext === null && (!node.title || node.title === node.obj_token)) {
          try {
            responseFileName = await requestAttachmentFilename(
              node.obj_token,
              String(++fileNameRequestSeq),
              runtimeMessage,
              (request) => activeRequests.track(request),
            );
          } catch (error) {
            if (stopped) throw cancelledError();
            log(appendSourceUrl(t('fileNameFallback', error.message), node.source_url));
          }
        }
        // 最终产物和附件共用这个入口。只重试网络错误、408、429 与 5xx；
        // 权限、链接不存在等确定性 4xx 立即失败，避免无意义等待。
        const blob = await retryAsync(
          () => fetchBlob(result.url, true, 120000),
          2,
          interruptibleWait,
          1000,
          (error) => error.retryable === true,
        );
        const title = titleFromDownload(node.title, result.fileName, responseFileName, result.ext);
        const stem = buildStem(index, path[path.length - 1], title, nameOpts);
        const plainName = withExt(stem, result.ext);
        const tokenName = addTokenToFilename(plainName, node.url_token, nameOpts.token);
        const name = uniqueName(dirPrefix + tokenName, used);

        if (withImages && result.ext === 'md') {
          // 同名文档不能落到同一个 assets 子目录，否则 zip 条目互相覆盖、图片串台。
          const imgDir = uniqueDir(safeSlug(stem), usedImgDirs);
          const localized = await localizeImages(await blob.text(), imgDir, dirPrefix);
          files.push(await toEntry(name, new Blob([localized.md], { type: 'text/markdown' })));
          files.push(...localized.entries);
          log(localized.entries.length ? t('okWithImages', name, localized.entries.length) : t('okPlain', name));
        } else {
          files.push(await toEntry(name, blob));
          log(t('okPlain', name));
        }
      } catch (e) {
        if (e && e.cancelled && stopped) { log(t('stopped')); break; }
        failed.push(items[i]);
        log(appendSourceUrl(t('itemFailed', node.title, e.message), node.source_url));
      }
      await sleep(1500); // 导出是服务端排队任务，别并发压它
    }

    if (files.length === 1) {
      // 只有一个文件就不打包了。但 a.download 里的 '/' 会被浏览器清洗掉，
      // 带目录前缀的话文件名会变成一坨，所以这里只取最后一段。
      triggerBlobDownload(files[0].blob, files[0].path.split('/').pop());
      log(t('doneSingle'));
    } else if (files.length > 1) {
      const stamp = new Date().toISOString().slice(0, 10);
      const zip = new Blob(zipParts(files), { type: 'application/zip' });
      triggerBlobDownload(zip, `${t('zipBaseName')}-${stamp}.zip`);
      log(t('doneZip', files.length, formatSize(zip.size)));
    } else {
      log(t('doneNothing'));
    }
    if (failed.length) log(t('summaryFailed', failed.length));
  }

  async function runSafely(items) {
    const startedAt = Date.now();
    try {
      await withCleanup(
        () => run(items, startedAt),
        () => finishRun(items, startedAt),
      );
    } catch (e) {
      const detail = e && e.code === 'zip_limit' ? t('errZipLimit') : ((e && e.message) || String(e));
      log(t('batchFailed', detail));
    }
  }

  // 右下角是飞书自己的地盘：文档页有两个悬浮按钮，表格页因为底部多了状态栏，
  // 帮助按钮又被顶高一截。挑任何一个固定的 bottom 都只是把碰撞挪到下一种页面类型，
  // 所以位置可拖、拖完记住。
  // 默认 150px 是量出来的不是拍的：表格页那个帮助按钮 80x33，占据底部 96–129px 一条，
  // 原来的 96px 正好压在上面（120px 也还压着），150px 让开。
  const FAB_POS_KEY = 'fbe-fab-pos';

  function placeFab(fab, right, bottom) {
    const w = fab.offsetWidth || 92;
    const h = fab.offsetHeight || 34;
    fab.style.right = `${Math.max(4, Math.min(right, window.innerWidth - w - 4))}px`;
    fab.style.bottom = `${Math.max(4, Math.min(bottom, window.innerHeight - h - 4))}px`;
  }

  function makeFabDraggable(fab, onClick) {
    const pos = () => ({
      right: parseFloat(fab.style.right) || 20,
      bottom: parseFloat(fab.style.bottom) || 150,
    });
    let drag = null;

    fab.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, ...pos(), moved: false };
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = drag.x - e.clientX;
      const dy = drag.y - e.clientY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return; // 4px 以内还算点击，手抖不该变成拖拽
      drag.moved = true;
      placeFab(fab, drag.right + dx, drag.bottom + dy);
    });
    fab.addEventListener('pointerup', (e) => {
      fab.releasePointerCapture(e.pointerId);
      const moved = drag && drag.moved;
      drag = null;
      if (!moved) { onClick(); return; }
      const saved = readSettings();
      saved[FAB_POS_KEY] = pos();
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(saved)); } catch (err) { /* 无痕模式等 */ }
    });
    // 窗口变小后，存下来的位置可能已经在屏幕外了
    window.addEventListener('resize', () => placeFab(fab, pos().right, pos().bottom));
  }

  function updateSourceControls() {
    const urlMode = $('fbe-src').value === 'urls';
    $('fbe-url-row').hidden = !urlMode;
    $('fbe-url-name').textContent = selectedUrlFile ? selectedUrlFile.name : t('urlNoFile');
  }

  function buildPanel() {
    const fab = document.createElement('button');
    fab.id = 'fbe-fab';
    fab.textContent = t('fab');
    fab.title = t('fabTip');

    const panel = document.createElement('div');
    panel.id = 'fbe-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header>${t('panelTitle')}
        <span class="fbe-head-right">
          <select id="fbe-lang" title="${t('langTip')}" aria-label="${t('langLabel')}">
            <option value="auto">${t('langAuto')}</option>
            <option value="zh_CN">中文</option>
            <option value="en">English</option>
          </select>
          <a id="fbe-repo" href="${REPO}" target="_blank" rel="noopener noreferrer"
             title="${t('repoTip')}" aria-label="${t('repoTip')}">
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
          </a>
          <button type="button" id="fbe-close" title="${t('collapse')}"
                  aria-label="${t('collapse')}">×</button>
        </span>
      </header>
      <div id="fbe-body">
      <div class="fbe-step"><b>1</b>${t('step1')}</div>
      <div class="fbe-row fbe-row--find">
        <select id="fbe-src" title="${t('srcTip')}">
          <option value="wiki">${t('srcWiki')}</option>
          <option value="folder">${t('srcFolder')}</option>
          <option value="drive">${t('srcDrive')}</option>
          <option value="urls">${t('srcUrls')}</option>
        </select>
        <button id="fbe-scan" class="fbe-btn">${t('listDocs')}</button>
        <input type="search" id="fbe-q" placeholder="${t('filterPlaceholder')}">
      </div>
      <div id="fbe-url-row" class="fbe-row fbe-row--file" hidden>
        <input type="file" id="fbe-url-file" accept=".txt,text/plain" hidden>
        <button type="button" id="fbe-url-choose" class="fbe-btn">${t('urlChooseFile')}</button>
        <span id="fbe-url-name" class="fbe-file-name"></span>
      </div>
      <div class="fbe-step"><b>2</b>${t('step2')}</div>

      <div id="fbe-tree"></div>
      <p id="fbe-empty">${t('emptyInvite')}</p>

      <div class="fbe-row fbe-row--tally">
        <span id="fbe-count"></span>
        <label class="fbe-check"><input type="checkbox" id="fbe-all">${t('selectAll')}</label>
        <select id="fbe-since" title="${t('recentTip')}">
          <option value="0">${t('recentHead')}</option>
          <option value="7">${t('recentDays', 7)}</option>
          <option value="30">${t('recentDays', 30)}</option>
          <option value="90">${t('recentDays', 90)}</option>
        </select>
      </div>

      <div class="fbe-step"><b>3</b>${t('step3')}</div>
      <div class="fbe-row fbe-row--format">
        <label class="fbe-lede" for="fbe-fmt">${t('formatLabel')}</label>
        <select id="fbe-fmt" title="${t('fmtAutoTip')}">
          <option value="auto">${t('fmtAuto')}</option>
          <option value="md">Markdown</option>
          <option value="docx">Word</option>
          <option value="pdf">PDF</option>
        </select>
      </div>

      <details id="fbe-more">
        <summary>${t('moreSettings')}</summary>
        <label class="fbe-opt"><input type="checkbox" id="fbe-img" checked>
          <span>${t('optImages')}<em>${t('optImagesTip')}</em></span></label>
        <label class="fbe-opt"><input type="checkbox" id="fbe-comment">
          <span>${t('optComment')}<em>${t('optCommentTip')}</em></span></label>
        <label class="fbe-opt"><input type="checkbox" id="fbe-dirs" checked>
          <span>${t('optDirs')}<em>${t('optDirsTip')}</em></span></label>
        <label class="fbe-opt"><input type="checkbox" id="fbe-num">
          <span>${t('optNum')}<em>${t('optNumTip')}</em></span></label>
        <label class="fbe-opt"><input type="checkbox" id="fbe-parent">
          <span>${t('optParent')}<em>${t('optParentTip')}</em></span></label>
        <label class="fbe-opt"><input type="checkbox" id="fbe-token">
          <span>${t('optToken')}<em>${t('optTokenTip')}</em></span></label>
        <p id="fbe-hint">${t('hintCascade')}<br>${t('hintTri')}</p>
      </details>
      </div>

      <div class="fbe-row fbe-row--go">
        <button id="fbe-start" class="fbe-btn fbe-btn--go" disabled>${t('btnStart')}</button>
        <button id="fbe-stop" class="fbe-btn" hidden>${t('btnStop')}</button>
        <button id="fbe-retry" class="fbe-btn" hidden></button>
      </div>

      <div id="fbe-progress" hidden>
        <div class="track"><div id="fbe-progress-fill"></div></div>
        <span id="fbe-progress-text"></span>
      </div>
      <div id="fbe-log-wrap" hidden>
        <div class="fbe-log-tools">
          <button type="button" id="fbe-log-copy" class="fbe-log-copy"
                  title="${t('copyLog')}">${t('copyLog')}</button>
        </div>
        <pre id="fbe-log"></pre>
      </div>`;

    document.body.append(fab, panel);

    // 开合时必须把焦点接过去：fab 一旦 hidden，停在它上面的焦点会掉到 <body>，
    // 键盘用户就得从整个飞书页面顶部重新 Tab 回来。关闭时再还给 fab。
    const open = () => {
      fab.hidden = true; panel.hidden = false;
      // 站内跳转不重载脚本，打开时重算一次，来源才真的「跟着页面走」
      const src = $('fbe-src').value === 'urls' ? 'urls' : sourceForPath(location.pathname);
      $('fbe-src').value = src;
      updateSourceControls();
      // 落在知识库文档页或文件夹页这种目标明确的页面上，打开就直接列出文档，省一次点击；
      // 知识库首页（src=wiki 但 URL 取不到 token）和「我的云空间」意图不明，不自动跑。
      // 同一页面不重复列，导出进行中也不跑。scan 自带 try/catch，这里不 await。
      const concrete = src !== 'urls'
        && (src === 'folder' || (src === 'wiki' && wikiTokenFromPath(location.pathname)));
      if (concrete && !running && listedFor !== location.pathname) scan();
      $('fbe-src').focus();
    };
    const close = () => {
      panel.hidden = true; fab.hidden = false;
      fab.focus();
    };
    // 浮层的标准预期。只在焦点确实在面板里时才响应，免得抢了页面自己的 Esc。
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !running) { e.stopPropagation(); close(); }
    });
    const savedPos = readSettings()[FAB_POS_KEY] || {};
    placeFab(fab, savedPos.right ?? 20, savedPos.bottom ?? 150);
    makeFabDraggable(fab, open);
    $('fbe-close').onclick = close;

    // 工具栏图标是第二个入口，走 background 转发过来的消息
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'fbe-toggle') (panel.hidden ? open : close)();
      });
    }
    $('fbe-scan').onclick = scan;
    $('fbe-q').oninput = applyFilter;
    $('fbe-since').onchange = (e) => selectRecent(Number(e.target.value));
    // 来源跟着当前页面走（首次打开；之后每次 open 都会按当前 URL 重算）
    $('fbe-src').value = listedFor === 'urls' ? 'urls' : sourceForPath(location.pathname);
    loadSettings();
    updateSourceControls();
    SETTING_IDS.forEach((id) => { $(id).addEventListener('change', saveSettings); });
    $('fbe-src').onchange = updateSourceControls;
    $('fbe-url-choose').onclick = () => $('fbe-url-file').click();
    $('fbe-url-file').onchange = (e) => {
      selectedUrlFile = e.target.files[0] || null;
      updateSourceControls();
    };
    $('fbe-all').onchange = (e) => {
      checkboxes().forEach((c) => { if (!c.disabled) c.checked = e.target.checked; });
      refreshMarks();
      refreshCount();
    };
    $('fbe-start').onclick = () => runSafely(checkboxes().flatMap((c, i) => (c.checked ? [rows[i]] : [])));
    $('fbe-stop').onclick = () => {
      stopped = true;
      $('fbe-stop').disabled = true;
      activeRequests.abortAll();
    };
    $('fbe-retry').onclick = () => runSafely(failed.slice());
    $('fbe-log-copy').onclick = copyCurrentLog;
    $('fbe-lang').onchange = async (e) => {
      await loadLocale(e.target.value);
      rebuildPanel();
    };
    showEmpty(rows.length ? '' : t('emptyInvite'));
    refreshCount();
  }

  // 面板的文案是建的时候一次性写进 DOM 的，所以换语言只能重建。
  // 重建会丢掉展开的树、勾选状态和日志 —— 那都是用户的活儿，不能因为换个显示语言就没了。
  function rebuildPanel() {
    const panel = $('fbe-panel');
    const wasOpen = panel && !panel.hidden;
    const logText = $('fbe-log') ? $('fbe-log').textContent : '';
    const checkedBefore = checkboxes().map((c) => c.checked);
    const query = $('fbe-q') ? $('fbe-q').value : '';
    const source = $('fbe-src') ? $('fbe-src').value : sourceForPath(location.pathname);

    if (panel) panel.remove();
    if ($('fbe-fab')) $('fbe-fab').remove();
    buildPanel();

    $('fbe-log').textContent = logText;
    $('fbe-log-wrap').hidden = !logText;
    $('fbe-log-wrap').classList.toggle('fbe-log-tools-on', LOG_TOOLS_ON_RE.test(logText));
    $('fbe-q').value = query;
    $('fbe-src').value = source;
    updateSourceControls();
    if (rows.length) {
      renderTree();
      checkboxes().forEach((c, i) => { c.checked = !!checkedBefore[i]; });
      refreshMarks();
      refreshCount();
      applyFilter();
    }
    if (wasOpen) { $('fbe-fab').hidden = true; $('fbe-panel').hidden = false; }
  }

  async function boot() {
    if ($('fbe-fab') || $('fbe-panel')) return;
    await loadLocale(readSettings()['fbe-lang']); // 语言得先定下来，面板才能建
    buildPanel();
  }

  boot();
})();
