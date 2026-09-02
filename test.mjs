// node --test test.mjs
// 直接把 content script 源码读进来求值，避免出现两份实现漂移。
// 脚本在 typeof document === 'undefined' 时会在导出纯函数后提前 return，所以 Node 里不会碰 UI。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./extension/content.js', import.meta.url), 'utf8');
const mod = { exports: {} };
new Function('module', src)(mod);
const {
  pickFormat, sanitizeName, uniqueName, flatten, findSpaceRoot,
  crc32, zipParts, imageExt, mdImageUrls, rewriteImageLinks, safeSlug, buildStem,
  descendantEnd, buildDirPrefix, nextSeq, etaSeconds, isFolder, asNode, editTime,
  withExt, formatSize, readCookie,
} = mod.exports;

test('readCookie: 按 cookie 名精确匹配，不被同后缀的名字骗到', () => {
  // 线上就栽在这里：原来是 document.cookie.match(/_csrf_token=([^;]+)/)，而
  // `_csrf_token=` 是 `passport_csrf_token=` 的后缀，飞书页面上后者就在。子串匹配取到
  // 它的值，/export/create/ 一律 403 csrf token error；列文档是 GET、不带这个头，
  // 所以现象是「能列出来、一篇也导不出」。
  const real = 'a1b2c3d4';
  assert.equal(readCookie(`passport_csrf_token=WRONG; _csrf_token=${real}`, '_csrf_token'), real);
  assert.equal(readCookie(`_csrf_token=${real}; passport_csrf_token=WRONG`, '_csrf_token'), real);
  // 撞车的不止 passport 一个：维护者自己的飞书页面上就带着 swp_csrf_token，同样以
  // _csrf_token 结尾。他一直没中招，只是排序侥幸把真的那个排在了前面。
  assert.equal(readCookie(`swp_csrf_token=WRONG; _csrf_token=${real}`, '_csrf_token'), real);
  assert.equal(readCookie('swp_csrf_token=WRONG; x_csrf_token=WRONG', '_csrf_token'), '',
    '没有就返回空串，绝不能退回一个别人的值 —— 那会发出一个注定 403 的请求');
});

test('readCookie: 边界不出怪话', () => {
  assert.equal(readCookie('', '_csrf_token'), '');
  assert.equal(readCookie(undefined, '_csrf_token'), '');
  assert.equal(readCookie('_csrf_token=', '_csrf_token'), '', '空值等于没有');
  assert.equal(readCookie('=orphan', '_csrf_token'), '', '没有名字的段落跳过，不能崩');
  // 值里的 = 不能被截断（base64 的 padding）
  assert.equal(readCookie('_csrf_token=YWJjZA==', '_csrf_token'), 'YWJjZA==');
  // 分隔符后面没空格也认，前后空白要去掉
  assert.equal(readCookie('a=1;_csrf_token=v;b=2', '_csrf_token'), 'v');
  assert.equal(readCookie('a=1;   _csrf_token=v   ', '_csrf_token'), 'v');
});

test('withExt: 标题已经带着目标扩展名就不再加一遍', () => {
  assert.equal(withExt('文案套路', 'md'), '文案套路.md');
  assert.equal(withExt('笔记.md', 'md'), '笔记.md', '不能变成 笔记.md.md');
  assert.equal(withExt('README.MD', 'md'), 'README.MD', '大小写不同也算同一个扩展名');
  assert.equal(withExt('体检.docx', null), '体检.docx', '附件沿用原标题，不加扩展名');
  assert.equal(withExt('年报.docx', 'pdf'), '年报.docx.pdf', '扩展名不同就该加');
});

test('formatSize: 小体积不报 0.0 MB', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(4096), '4 KB');
  // 几个 md 文件本来就到不了 1 MB，报 0.0 MB 看着像什么都没导出来
  assert.equal(formatSize(300 * 1024), '300 KB');
  assert.equal(formatSize(3 * 1048576), '3.0 MB');
  assert.equal(formatSize(12.34 * 1048576), '12.3 MB');
});

test('asNode: 把云空间节点归一成知识库节点的形状', () => {
  // 云空间的字段叫 name/type/token，知识库叫 title/obj_type/wiki_token
  const drive = {
    name: '365 开源计划', type: 22, token: 'nodxxx',
    obj_token: 'Q9kAdvXY3oqr', edit_time: '1784289526',
  };
  assert.deepEqual(asNode(drive), {
    title: '365 开源计划', obj_token: 'Q9kAdvXY3oqr', obj_type: 22,
    wiki_token: 'nodxxx', has_child: false, edit_time: 1784289526,
  });
  // 归一之后 pickFormat 就能直接吃 —— 整条流水线不用管来源
  assert.deepEqual(pickFormat(asNode(drive).obj_type, 'md'), { api: 'docx', ext: 'md' });
});

test('isFolder: 云空间里文件夹是 0（子文件夹）或 4（空间根）', () => {
  assert.equal(isFolder({ type: 0 }), true);
  assert.equal(isFolder({ type: 4 }), true);
  assert.equal(isFolder({ type: 22 }), false, 'docx 不是文件夹');
  assert.equal(isFolder({ type: 8 }), false, '多维表格不是文件夹');
  assert.equal(asNode({ type: 0, name: 'life os', token: 'fldxxx' }).has_child, true);
});

test('editTime: 两种来源的修改时间都取得到', () => {
  assert.equal(editTime({ edit_time: '1784289526' }), 1784289526, '云空间放顶层');
  assert.equal(editTime({ detail_info: { edit_time: '1642318440' } }), 1642318440, '知识库放 detail_info');
  assert.equal(editTime({}), 0);
  assert.equal(editTime(undefined), 0, '拿不到时间就当最老，不会被「N 天内」误选');
});

test('etaSeconds: 按实测均速估，边界不出怪话', () => {
  assert.equal(etaSeconds(0, 0, 10), null, '一篇都没完成时估不出来，不猜');
  assert.equal(etaSeconds(10, 5000, 10), null, '做完了就不显示');
  assert.equal(etaSeconds(2, 4000, 12), 20, '2 篇 4 秒 → 剩 10 篇 20 秒');
  assert.equal(etaSeconds(1, 3000, 101), 300);
});

// ── i18n ──
// 两份 messages.json 迟早会漂，而漂了之后英文界面只会露出一个 key，
// 不报错也不崩 —— 只有测试能抓住。
const locale = (lang) => JSON.parse(
  readFileSync(new URL(`./extension/_locales/${lang}/messages.json`, import.meta.url), 'utf8'));
const zh = locale('zh_CN');
const en = locale('en');

test('i18n: 两份 messages.json 的 key 完全一致', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test('i18n: 同一个 key 两边的占位符个数要一样', () => {
  for (const key of Object.keys(zh)) {
    const count = (s) => new Set(s.match(/\$\d/g) || []).size;
    assert.equal(count(en[key].message), count(zh[key].message), `${key} 的占位符对不上`);
  }
});

test('i18n: 代码和 manifest 用到的 key 都存在，messages 里也没有没人用的', () => {
  const manifestSrc = readFileSync(new URL('./extension/manifest.json', import.meta.url), 'utf8');
  const used = new Set([
    ...[...src.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]),          // t('key')
    ...[...src.matchAll(/key:\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]),        // TYPES 里的间接引用
    ...[...manifestSrc.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]), // manifest 里的引用
  ]);

  const declared = new Set(Object.keys(zh));
  const missing = [...used].filter((k) => !declared.has(k));
  const unused = [...declared].filter((k) => !used.has(k));
  assert.deepEqual(missing, [], '代码里用了但 messages.json 没有的 key');
  assert.deepEqual(unused, [], 'messages.json 里没人用的 key');
});

test('i18n: 商店字段不能超 Chrome 的长度上限', () => {
  // 超限是静默的 —— 装的时候才发现名字被截或者扩展加载不了
  for (const [lang, m] of [['zh_CN', zh], ['en', en]]) {
    assert.ok(m.extName.message.length <= 45, `${lang} 的扩展名超过 45 字符`);
    assert.ok(m.extDesc.message.length <= 132,
      `${lang} 的描述 ${m.extDesc.message.length} 字符，超过 132`);
  }
});

test('i18n: 界面上不该再有写死的中文', () => {
  // 语言选择器里的语言名按惯例用该语言自己的写法，不翻译 —— 看不懂当前界面语言的人
  // 正是要靠这个找到自己的语言。
  const ALLOWED = new Set(['中文']);

  // 注释里的中文不算。块注释也要去掉，否则行内的 /* 存坏了就用默认值 */ 会误报。
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const stray = [...new Set([...code.matchAll(/[一-鿿]+/g)].map((m) => m[0]))]
    .filter((s) => !ALLOWED.has(s));
  assert.deepEqual(stray, [], '这些中文还没进 _locales');
});

test('nextSeq: 按目录分别计数，平铺时退化成全局计数', () => {
  const c = new Map();
  // 保留目录结构：每个文件夹各自从 1 开始，不会出现 007、019 这种跳号
  assert.equal(nextSeq(c, '父/'), 1);
  assert.equal(nextSeq(c, '父/'), 2);
  assert.equal(nextSeq(c, '另一个/'), 1);
  assert.equal(nextSeq(c, '父/'), 3);

  // 平铺时 dirPrefix 恒为 ''，同一个计数器，等价于全局序号
  const flat = new Map();
  assert.deepEqual([1, 2, 3].map(() => nextSeq(flat, '')), [1, 2, 3]);
});

test('buildDirPrefix: 关掉就是空串，开了每段都过 safeSlug', () => {
  assert.equal(buildDirPrefix(['父', '子'], false), '');
  assert.equal(buildDirPrefix([], true), '', '顶层文档没有祖先');
  assert.equal(buildDirPrefix(['父', '子'], true), '父/子/');
  // 目录名会进 md 的相对路径，空格照样会弄断 ![](…)
  assert.equal(buildDirPrefix(['✒️Blog 文章发布', '文案 (旧)'], true), '✒️Blog_文章发布/文案_旧_/');
});

test('uniqueName: 带目录时只给最后一段加序号', () => {
  const used = new Set();
  assert.equal(uniqueName('父/子/标题.md', used), '父/子/标题.md');
  assert.equal(uniqueName('父/子/标题.md', used), '父/子/标题 (2).md');
  // 目录名里带点时，不能把 (2) 插进目录名里去
  const used2 = new Set();
  assert.equal(uniqueName('v1.0/标题.md', used2), 'v1.0/标题.md');
  assert.equal(uniqueName('v1.0/标题.md', used2), 'v1.0/标题 (2).md');
});

test('descendantEnd: 后代是紧随其后 depth 更大的连续一段', () => {
  //  0 根
  //  1   子1
  //  2     孙
  //  3   子2
  //  4 另一个根
  const rows = [0, 1, 2, 1, 0].map((depth) => ({ depth }));
  assert.equal(descendantEnd(rows, 0), 4, '根的后代到「另一个根」之前为止');
  assert.equal(descendantEnd(rows, 1), 3, '子1 只含孙');
  assert.equal(descendantEnd(rows, 2), 3, '叶子没有后代');
  assert.equal(descendantEnd(rows, 3), 4, '子2 是叶子');
  assert.equal(descendantEnd(rows, 4), 5, '最后一项');
});

test('safeSlug: 干掉会弄断 markdown 链接的字符，中文保留', () => {
  // 真实的 stem 长这样，带空格 —— 空格会让 ![](a b/1.png) 解析不出来
  assert.equal(safeSlug('001-✒️Blog 文章发布-✍️文案'), '001-✒️Blog_文章发布-✍️文案');
  assert.equal(safeSlug('带(括号)和[方括号]'), '带_括号_和_方括号_');
  assert.equal(safeSlug('井号#问号?百分号%'), '井号_问号_百分号_');
});

test('safeSlug 的产物放进 md 链接里能被解析回来', () => {
  const dir = safeSlug('001-✒️Blog 文章发布-✍️文案');
  const md = `![Image](assets/${dir}/001.png)`;
  const m = /!\[([^\]]*)\]\(([^)\s]+)\)/.exec(md);
  assert.ok(m, 'markdown 图片语法必须能整体匹配上，不能被空格截断');
  assert.equal(m[2], `assets/${dir}/001.png`);
});

test('buildStem: 序号与父目录各自可关', () => {
  const both = { number: true, parent: true };
  assert.equal(buildStem(7, '父目录', '标题', both), '007-父目录-标题');
  assert.equal(buildStem(7, '父目录', '标题', { number: false, parent: true }), '父目录-标题');
  assert.equal(buildStem(7, '父目录', '标题', { number: true, parent: false }), '007-标题');
  assert.equal(buildStem(7, '父目录', '标题', { number: false, parent: false }), '标题');
  assert.equal(buildStem(7, undefined, '顶层文档', both), '007-顶层文档', '顶层节点没有父目录');
});

const bytes = (s) => new TextEncoder().encode(s);

test('crc32: 对上标准校验值', () => {
  // CRC-32/ISO-HDLC 的公认 check value："123456789" → 0xCBF43926
  assert.equal(crc32(bytes('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zipParts: 中央目录偏移等于本地区总长，EOCD 数目对得上', async () => {
  const entries = [];
  for (const [path, body] of [['a.md', '# 标题'], ['assets/a/001.png', 'PNGDATA']]) {
    const blob = new Blob([body]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    entries.push({ path, blob, crc: crc32(buf), size: buf.length });
  }
  const all = new Uint8Array(await new Blob(zipParts(entries, new Date(2026, 7, 5))).arrayBuffer());
  const dv = new DataView(all.buffer);

  assert.equal(dv.getUint32(0, true), 0x04034b50, '开头是 local file header 签名');

  // EOCD 在最后 22 字节（我们不写 comment）
  const eocd = all.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, '结尾是 EOCD 签名');
  assert.equal(dv.getUint16(eocd + 10, true), 2, '总条目数');

  const cdOffset = dv.getUint32(eocd + 16, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  assert.equal(dv.getUint32(cdOffset, true), 0x02014b50, 'cd offset 指向 central header');
  assert.equal(cdOffset + cdSize + 22, all.length, '三段长度拼起来正好是全长');

  // 第一条的本地头里，长度字段要跟真实内容一致，否则解压器会读错位
  const nameLen = dv.getUint16(26, true);
  assert.equal(new TextDecoder().decode(all.slice(30, 30 + nameLen)), 'a.md');
  assert.equal(dv.getUint32(22, true), bytes('# 标题').length);
  assert.equal(dv.getUint32(14, true), crc32(bytes('# 标题')));
});

test('zipParts: 文件名按 UTF-8 存并置语言编码位', async () => {
  const blob = new Blob(['x']);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const parts = zipParts([{ path: '中文-标题.md', blob, crc: crc32(buf), size: buf.length }]);
  const all = new Uint8Array(await new Blob(parts).arrayBuffer());
  const dv = new DataView(all.buffer);
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800, 'flag bit 11 必须置位，否则中文名乱码');
  const nameLen = dv.getUint16(26, true);
  assert.equal(new TextDecoder().decode(all.slice(30, 30 + nameLen)), '中文-标题.md');
});

test('imageExt: 按 MIME 定扩展名，认不出就当 png', () => {
  assert.equal(imageExt('image/png'), 'png');
  assert.equal(imageExt('image/jpeg'), 'jpg');
  assert.equal(imageExt('image/svg+xml; charset=utf-8'), 'svg');
  assert.equal(imageExt('application/octet-stream'), 'png');
  assert.equal(imageExt(undefined), 'png');
});

test('mdImageUrls: 抓出图片链接并去重，飞书和 Lark 两边的图床都认', () => {
  const md = [
    '![Image](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=AAA)',
    '![](https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/authcode/?code=AAA)',
    // Lark 的图床域名带区域后缀，实测是这个形状
    '![Image](https://internal-api-drive-stream-jp.larksuite.com/space/api/box/stream/download/authcode/?code=BBB)',
    '![别的](https://example.com/x.png)',
    '[不是图片](https://internal-api-drive-stream.feishu.cn/y.png)',
  ].join('\n');
  const urls = mdImageUrls(md);
  assert.equal(urls.length, 2, '同一个 URL 只抓一次，站外图和普通链接不碰');
  assert.match(urls[0], /code=AAA$/);
  assert.match(urls[1], /larksuite\.com.*code=BBB$/);
});

test('mdImageUrls: 图床的区域后缀变了也照样认', () => {
  // 实测到的是 -jp，但 Lark 各区域后缀不同，将来也可能变。域名前缀是通配的，
  // 这条断言就是用来保证以后加区域不用改代码。
  const hosts = [
    'internal-api-drive-stream-jp.larksuite.com',
    'internal-api-drive-stream-sg.larksuite.com',
    'internal-api-drive-stream-us.larksuite.com',
    'internal-api-drive-stream.larksuite.com',
    'whatever-new-cdn-name.larksuite.com',
    'internal-api-drive-stream.feishu.cn',
  ];
  const md = hosts.map((h, i) => `![x](https://${h}/space/api/box/stream/download/authcode/?code=C${i})`).join('\n');
  assert.equal(mdImageUrls(md).length, hosts.length);

  // 但别把域名放得太开 —— 长得像的第三方域名不能碰
  assert.equal(mdImageUrls('![x](https://evil-larksuite.com/a.png)').length, 0);
  assert.equal(mdImageUrls('![x](https://larksuite.com.attacker.net/a.png)').length, 0);
});

test('rewriteImageLinks: 只改抓下来的，抓不到的原样留着', () => {
  const a = 'https://internal-api-drive-stream.feishu.cn/a.png';
  const b = 'https://internal-api-drive-stream.feishu.cn/b.png';
  const md = `![图一](${a})\n![图二](${b})`;
  const out = rewriteImageLinks(md, { [a]: 'assets/doc/001.png' });
  assert.equal(out, `![图一](assets/doc/001.png)\n![图二](${b})`);
});

// 照实测抄下来的空间形状：真实节点串成链，链顶那个 token（虚拟根）get_node 会失败，
// 只能拿来 get_node_child。
const SPACE = {
  leaf:   { wiki_token: 'leaf',   parent_wiki_token: 'mid',  space_id: '700' },
  mid:    { wiki_token: 'mid',    parent_wiki_token: 'top',  space_id: '700' },
  top:    { wiki_token: 'top',    parent_wiki_token: 'VIRT', space_id: '700' },
};
const fakeFetch = (token, soft) => {
  const node = SPACE[token];
  if (node) return Promise.resolve(node);
  if (soft) return Promise.resolve(null); // 虚拟根：接口报 code 2
  return Promise.reject(new Error(`读取节点失败 2 InvalidParam (${token})`));
};

test('findSpaceRoot: 停在虚拟根，不去 get_node 它', async () => {
  const r = await findSpaceRoot('leaf', fakeFetch);
  assert.equal(r.spaceId, '700');
  assert.equal(r.rootToken, 'VIRT');
  assert.equal(r.rootNode, null); // null ⇒ 调用方得从它的子节点开始扫，不能把它当节点
});

test('findSpaceRoot: 根本身是真实节点时把它带上', async () => {
  const solo = { wiki_token: 'solo', parent_wiki_token: '', space_id: '700' };
  const r = await findSpaceRoot('solo', () => Promise.resolve(solo));
  assert.equal(r.rootToken, 'solo');
  assert.equal(r.rootNode, solo);
});

test('findSpaceRoot: 起点读不出来就抛，不静默吞掉', async () => {
  await assert.rejects(() => findSpaceRoot('不存在', fakeFetch), /InvalidParam/);
});

test('pickFormat: 想要的格式支持就用它', () => {
  assert.deepEqual(pickFormat(2, 'pdf'), { api: 'doc', ext: 'pdf' });
  assert.deepEqual(pickFormat(22, 'md'), { api: 'docx', ext: 'md' });
});

test('pickFormat: 不支持就退回该类型的默认格式', () => {
  // 表格只能 xlsx，选了 md 也得给 xlsx，而不是抛错或发一个必被 1018 拒掉的请求
  assert.deepEqual(pickFormat(3, 'md'), { api: 'sheet', ext: 'xlsx' });
  assert.deepEqual(pickFormat(8, 'pdf'), { api: 'bitable', ext: 'xlsx' });
});

test('pickFormat: auto 取默认格式', () => {
  assert.equal(pickFormat(2, 'auto').ext, 'md');
  assert.equal(pickFormat(3, 'auto').ext, 'xlsx');
});

test('pickFormat: 附件直下，思维笔记与未知类型不支持', () => {
  assert.deepEqual(pickFormat(12, 'auto'), { api: null, ext: null });
  assert.equal(pickFormat(11, 'auto'), null); // 思维笔记：飞书不给任何可用扩展名
  assert.equal(pickFormat(999, 'auto'), null);
});

test('sanitizeName: 清掉文件名非法字符', () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitizeName('  多余   空白  '), '多余 空白');
  assert.equal(sanitizeName('...隐藏文件'), '隐藏文件');
  assert.equal(sanitizeName(''), 'untitled');
  assert.equal(sanitizeName(null), 'untitled');
  assert.equal(sanitizeName('x'.repeat(200)).length, 80);
});

test('uniqueName: 重名追加序号且保留扩展名', () => {
  const used = new Set();
  assert.equal(uniqueName('a.md', used), 'a.md');
  assert.equal(uniqueName('a.md', used), 'a (2).md');
  assert.equal(uniqueName('a.md', used), 'a (3).md');
  assert.equal(uniqueName('无后缀', used), '无后缀');
  assert.equal(uniqueName('无后缀', used), '无后缀 (2)');
});

test('flatten: 深度优先，后代是紧随其后 depth 更大的连续一段', () => {
  const n = (title) => ({ title, obj_type: 2 });
  const rows = flatten([
    { node: n('根'), children: [
      { node: n('子1'), children: [{ node: n('孙'), children: [] }] },
      { node: n('子2'), children: [] },
    ] },
  ]);
  assert.deepEqual(rows.map((r) => [r.node.title, r.depth]), [
    ['根', 0], ['子1', 1], ['孙', 2], ['子2', 1],
  ]);
  // 面板的级联勾选依赖这条性质：子1 的后代正好是它后面 depth>1 的那一段
  assert.deepEqual(rows[1].path, ['根']);
  assert.deepEqual(rows[2].path, ['根', '子1']);
});
