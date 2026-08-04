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
  const asNode = (n) => ({
    title: n.name,
    obj_token: n.obj_token,
    obj_type: n.type,
    wiki_token: n.token,
    has_child: isFolder(n),
    edit_time: Number(n.edit_time) || 0,
  });

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

  // 小于 1 MB 时显示 KB。几个 md 文件本来就到不了 1 MB，
  // 报「0.0 MB」看着像是什么都没导出来。单位不用翻译。
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

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
    const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.path);
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

    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, offset, true);
    return parts.concat(central, [eocd.buffer]);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      pickFormat, sanitizeName, uniqueName, flatten, findSpaceRoot, TYPES,
      crc32, zipParts, imageExt, mdImageUrls, rewriteImageLinks, safeSlug, buildStem, descendantEnd,
      buildDirPrefix, nextSeq, etaSeconds, isFolder, asNode, editTime, withExt, formatSize,
    };
  }
  if (typeof document === 'undefined') return; // Node 里跑测试时到此为止

  // ───────────────────────── 通信 ─────────────────────────

  const REPO = 'https://github.com/rockbenben/feishu-lark-batch-export';
  const API = '/space/api';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const csrf = () => (document.cookie.match(/_csrf_token=([^;]+)/) || [])[1] || '';

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
    return (typeof chrome !== 'undefined' && chrome.i18n
      && chrome.i18n.getMessage(key, subs.map(String))) || key;
  }

  function loadLocale(lang) {
    if (!LANGS.includes(lang)) { MSG = null; return Promise.resolve(); }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'fbe-locale', lang }, (res) => {
        void chrome.runtime.lastError; // service worker 没起来时别往控制台喷
        MSG = res || null;             // 读不到就退回浏览器语言，别把界面变成一堆 key
        resolve();
      });
    });
  }

  const typeName = (objType) =>
    (TYPES[objType] ? t(TYPES[objType].key) : t('typeUnknown', objType));

  // 飞书的 policy-sdk 劫持了 window.fetch，自发的 fetch 一律 Failed to fetch。必须用 XHR。
  function xhr(method, url, body) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open(method, url, true);
      x.withCredentials = true;
      if (body) {
        x.setRequestHeader('Content-Type', 'application/json');
        x.setRequestHeader('x-csrftoken', csrf());
      }
      x.onload = () => {
        try { resolve(JSON.parse(x.responseText)); }
        catch (e) { reject(new Error(t('errNotJson', x.status))); }
      };
      x.onerror = () => reject(new Error(t('errNetwork')));
      x.send(body ? JSON.stringify(body) : null);
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

  // ── 云空间（非知识库）──
  // 实测：参数越少越好，加 type/rank 那些反而 500。node_list 才是真正的子项，
  // entities.nodes 里还混着父节点自己。分页靠 has_more + last_label。
  async function driveList(path, extra = '') {
    const out = [];
    let label = '';
    for (let page = 0; page < 40; page++) {
      const url = `${API}/explorer/v3/${path}?length=50${extra}`
        + (label ? `&last_label=${encodeURIComponent(label)}` : '');
      const r = await xhr('GET', url);
      if (r.code !== 0) throw new Error(t('errReadDrive', `${r.code} ${r.msg || ''}`));
      const d = r.data || {};
      const nodes = (d.entities && d.entities.nodes) || {};
      for (const token of d.node_list || []) if (nodes[token]) out.push(nodes[token]);
      if (!d.has_more || !d.last_label || d.last_label === label) break; // 游标不前进就停，别死循环
      label = d.last_label;
    }
    return out;
  }

  async function getChildren(spaceId, wikiToken) {
    const url = `${API}/wiki/v2/tree/get_node_child/?space_id=${spaceId}&wiki_token=${wikiToken}`
      + '&expand_shortcut=true&exclude_fields=5&is_pre_heating=false';
    const r = await xhr('GET', url);
    if (r.code !== 0) throw new Error(t('errReadChildren', `${r.code} ${r.msg || ''}`));
    return (r.data && r.data[wikiToken]) || [];
  }

  // 返回 {url, ext}。ext 为 null 表示文件名沿用节点标题（附件本来就带后缀）。
  async function exportOne(node, fmt, needComment) {
    if (fmt.api === null) return { url: `${API}/box/stream/download/all/${node.obj_token}`, ext: null };

    const created = await xhr('POST', `${API}/export/create/`, {
      token: node.obj_token, type: fmt.api, file_extension: fmt.ext,
      event_source: '1', need_comment: !!needComment, sub_id: '',
    });
    if (created.code !== 0) throw new Error(t('errCreate', `${created.code} ${created.msg || ''}`));

    const ticket = created.data.ticket;
    const query = `${API}/export/result/${ticket}?token=${node.obj_token}&type=${fmt.api}`;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const r = await xhr('GET', query);
      if (r.code !== 0) throw new Error(t('errQuery', `${r.code} ${r.msg || ''}`));
      const res = (r.data && r.data.result) || {};
      if (res.job_status === 0) {
        return { url: `${API}/box/stream/download/all/${res.file_token}`, ext: res.file_extension || fmt.ext };
      }
      // 1/2 = 排队中/处理中；其余非零一律当失败
      if (res.job_status !== 1 && res.job_status !== 2) {
        throw new Error(res.job_error_msg || t('errExport', res.job_status));
      }
    }
    throw new Error(t('errTimeout'));
  }

  // 图片那些 authcode 链接实测必须 withCredentials=false —— 带 cookie 会被 CORS 拒。
  function fetchBlob(url, withCredentials = true) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('GET', url, true);
      x.withCredentials = withCredentials;
      x.responseType = 'blob';
      x.onload = () => (x.status === 200 ? resolve(x.response) : reject(new Error(`HTTP ${x.status}`)));
      x.onerror = () => reject(new Error(t('errNetwork')));
      x.send();
    });
  }

  // 读一遍算 CRC，然后丢掉 ArrayBuffer，只留 Blob（浏览器管，可落盘）。
  async function toEntry(path, blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { path, blob, crc: crc32(bytes), size: bytes.length };
  }

  // 图片放在 md 同级的 assets/ 下，所以 md 里写的相对链接跟目录深度无关，
  // 开不开「保留目录结构」都不用改写成 ../../ 那种东西。
  async function localizeImages(md, stem, dirPrefix) {
    const urls = mdImageUrls(md);
    const dir = safeSlug(stem);
    const mapping = {};   // url → md 里的相对链接
    const entries = [];
    for (const url of urls) {
      try {
        const blob = await fetchBlob(url, false);
        const rel = `assets/${dir}/${String(entries.length + 1).padStart(3, '0')}.${imageExt(blob.type)}`;
        mapping[url] = rel;
        entries.push(await toEntry(dirPrefix + rel, blob));
      } catch (e) {
        log(t('imgFailed', e.message));
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

  const $ = (id) => document.getElementById(id);

  function log(msg) {
    const el = $('fbe-log');
    el.hidden = false; // 没话说的时候不占地方
    el.textContent += (el.textContent ? '\n' : '') + msg;
    el.scrollTop = el.scrollHeight;
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
  const SETTING_IDS = ['fbe-lang', 'fbe-fmt', 'fbe-img', 'fbe-comment', 'fbe-num', 'fbe-parent', 'fbe-dirs'];

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

  async function scanWiki(onFolder) {
    const match = location.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
    if (!match) throw new Error(t('errNotWiki'));

    const { spaceId, rootToken, rootNode } = await findSpaceRoot(match[1], getNode);
    const walk = async (node) => {
      const item = { node, children: [] };
      if (node.has_child) {
        onFolder();
        for (const child of await getChildren(spaceId, node.wiki_token)) item.children.push(await walk(child));
      }
      return item;
    };
    const tops = rootNode ? [rootNode] : await getChildren(spaceId, rootToken);
    const items = [];
    for (const node of tops) items.push(await walk(node));
    return items;
  }

  async function scanDrive(onFolder) {
    const walk = async (node) => {
      const item = { node, children: [] };
      if (node.has_child) {
        onFolder();
        const kids = await driveList('children/list/', `&token=${node.wiki_token}`);
        for (const child of kids) item.children.push(await walk(asNode(child)));
      }
      return item;
    };
    // 根目录的文件夹和文档分两个接口，合起来才是完整的一层
    const roots = [
      ...await driveList('my_space/folder/'),
      ...await driveList('my_space/obj/'),
    ];
    const items = [];
    for (const n of roots) items.push(await walk(asNode(n)));
    return items;
  }

  async function scan() {
    const button = $('fbe-scan');
    button.disabled = true;
    $('fbe-log').textContent = '';
    $('fbe-log').hidden = true;
    showEmpty(t('listing'));
    try {
      let folders = 0;
      const onFolder = () => { if (++folders % 10 === 0) showEmpty(t('listExpanded', folders)); };
      const items = $('fbe-src').value === 'drive' ? await scanDrive(onFolder) : await scanWiki(onFolder);
      rows = flatten(items);
      renderTree();
      log(t('listDone', rows.length, folders));
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

  async function run(items) {
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
    const nameOpts = { number: $('fbe-num').checked, parent: $('fbe-parent').checked };
    const keepTree = $('fbe-dirs').checked;
    const needComment = $('fbe-comment').checked;
    const used = new Set();
    const seq = new Map();
    const startedAt = Date.now();
    const files = [];   // {path, blob, crc, size}

    for (let i = 0; i < items.length; i++) {
      if (stopped) { log(t('stopped')); break; }
      const { node, path } = items[i];
      setProgress(i, items.length, Date.now() - startedAt);
      try {
        const fmt = pickFormat(node.obj_type, want);
        if (!fmt) { log(t('skipUnsupported', node.title, typeName(node.obj_type))); continue; }

        const result = await exportOne(node, fmt, needComment);
        const dirPrefix = buildDirPrefix(path, keepTree);
        const stem = buildStem(nextSeq(seq, dirPrefix), path[path.length - 1], node.title, nameOpts);
        const name = uniqueName(dirPrefix + withExt(stem, result.ext), used);
        const blob = await fetchBlob(result.url);

        if (withImages && result.ext === 'md') {
          const localized = await localizeImages(await blob.text(), stem, dirPrefix);
          files.push(await toEntry(name, new Blob([localized.md], { type: 'text/markdown' })));
          files.push(...localized.entries);
          log(localized.entries.length ? t('okWithImages', name, localized.entries.length) : t('okPlain', name));
        } else {
          files.push(await toEntry(name, blob));
          log(t('okPlain', name));
        }
      } catch (e) {
        failed.push(items[i]);
        log(t('itemFailed', node.title, e.message));
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

    running = false;
    setProgress(items.length, items.length, Date.now() - startedAt);
    $('fbe-stop').hidden = true;
    $('fbe-scan').disabled = false;
    $('fbe-retry').hidden = failed.length === 0;
    $('fbe-retry').textContent = t('btnRetry', failed.length); // 说清楚要重试几篇
    refreshCount();
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
          <option value="drive">${t('srcDrive')}</option>
        </select>
        <button id="fbe-scan" class="fbe-btn">${t('listDocs')}</button>
        <input type="search" id="fbe-q" placeholder="${t('filterPlaceholder')}">
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
      <pre id="fbe-log" hidden></pre>`;

    document.body.append(fab, panel);

    // 开合时必须把焦点接过去：fab 一旦 hidden，停在它上面的焦点会掉到 <body>，
    // 键盘用户就得从整个飞书页面顶部重新 Tab 回来。关闭时再还给 fab。
    const open = () => {
      fab.hidden = true; panel.hidden = false;
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
    // 来源跟着当前页面走：在 /wiki/ 上默认扫知识库，其它页面默认扫云空间
    $('fbe-src').value = /\/wiki\//.test(location.pathname) ? 'wiki' : 'drive';
    loadSettings();
    SETTING_IDS.forEach((id) => { $(id).addEventListener('change', saveSettings); });
    $('fbe-all').onchange = (e) => {
      checkboxes().forEach((c) => { if (!c.disabled) c.checked = e.target.checked; });
      refreshMarks();
      refreshCount();
    };
    $('fbe-start').onclick = () => run(checkboxes().flatMap((c, i) => (c.checked ? [rows[i]] : [])));
    $('fbe-stop').onclick = () => { stopped = true; $('fbe-stop').disabled = true; };
    $('fbe-retry').onclick = () => run(failed.slice());
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

    if (panel) panel.remove();
    if ($('fbe-fab')) $('fbe-fab').remove();
    buildPanel();

    $('fbe-log').textContent = logText;
    $('fbe-q').value = query;
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
