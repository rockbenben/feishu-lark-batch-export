// UI 回归检查 —— 在真实 Chrome 里加载**真实的** extension/content.js，打真实的鼠标事件。
//
// 为什么需要它：test.mjs 在 content.js 的 `typeof document === 'undefined'` 守卫处就返回了，
// 所有 DOM 层代码都在覆盖之外。也就是说面板勾选、级联、过滤、重扫、切语言这些行为，
// CI 全绿也证明不了任何事。这个脚本把那层补上：改 UI 之后行为一旦回退，这里会红。
//
// 用法：node test/ui/check-ui.mjs        （失败时 exit 1）
// 零依赖，与项目其余部分一致。Chrome 路径可用 CHROME_PATH 覆盖。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE_TIMEOUT_MS = 60_000;
const ZH = JSON.parse(await readFile(path.join(ROOT, 'extension', '_locales', 'zh_CN', 'messages.json'), 'utf8'));

// ───────────────────────── 静态服务（只暴露夹具与真实扩展） ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

function resolveFile(urlPath) {
  const p = decodeURIComponent(urlPath.split('?')[0]);
  // /wiki/** 与 /drive/** 都落到夹具：路径决定 content.js 的 sourceForPath 结果
  if (/^\/wiki\//.test(p) || /^\/drive(\/|$)/.test(p) || p === '/harness') {
    return path.join(ROOT, 'test', 'ui', 'fixture.html');
  }
  if (p === '/healthz') return null; // 让 server.listen 之前的探活有明确回包
  if (p.startsWith('/extension/')) return path.join(ROOT, p);
  return null;
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  const file = resolveFile(req.url);
  if (!file || !file.startsWith(ROOT)) { res.writeHead(404); res.end('not found'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('missing');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ───────────────────────── 找 Chrome ─────────────────────────
function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const win = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const linux = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  const mac = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const all = process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : linux;
  return all.find((p) => existsSync(p)) || null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('找不到 Chrome。装一个，或用 CHROME_PATH 指定可执行文件路径。');
  server.close();
  process.exit(1);
}

// ───────────────────────── 启动 Chrome ─────────────────────────
const profile = mkdtempSync(path.join(tmpdir(), 'fbe-ui-'));
const isLinux = process.platform === 'linux';
const child = spawn(chromePath, [
  '--headless=new', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900',
  ...(isLinux ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  'about:blank',
], { stdio: 'ignore' });

// 端口 0 ⇒ Chrome 自己挑一个，写进 DevToolsActivePort
let cdpBase = null;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, 'utf8').split('\n');
      if (port && port.trim()) { cdpBase = `http://127.0.0.1:${port.trim()}`; break; }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
} catch { /* 下面统一处理 */ }

function cleanup() {
  try { child.kill(); } catch { /* 已经退出就算了 */ }
  try { server.close(); } catch { /* 同上 */ }
}

if (!cdpBase) {
  console.error('Chrome 起来了但没给 DevTools 端口，检查沙箱/容器权限。');
  cleanup();
  process.exit(1);
}

// ───────────────────────── CDP ─────────────────────────
const ver = await (await fetch(`${cdpBase}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let msgId = 0;
const waiting = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const i = ++msgId; waiting.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const value = (r) => r?.result?.result?.value;

const tgt = await send('Target.createTarget', { url: 'about:blank' });
const sessionId = (await send('Target.attachToTarget', { targetId: tgt.result.targetId, flatten: true })).result.sessionId;
const S = (m, p) => send(m, p, sessionId);
await S('Page.enable'); await S('Runtime.enable');
await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const evalJS = async (expr) => value(await S('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }));

// 真实鼠标事件。合成 MouseEvent 不可信：Chrome 里 dispatchEvent('click') 会真的切换
// checkbox，级联读到的是翻转后的值，结果全错。Alt 用 modifiers 位（1=Alt,2=Ctrl,4=Shift,8=Meta）。
async function realClick(index, modifiers = 0) {
  const pt = await evalJS(`(() => {
    const el = document.querySelectorAll('#fbe-tree input[type=checkbox]')[${index}];
    if (!el || el.disabled) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!pt) return false; // 目标不可点（禁用行）——由调用方决定这是否算失败
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1, modifiers });
  await new Promise((r) => setTimeout(r, 120));
  return true;
}

async function realClickName(text) {
  const pt = await evalJS(`(() => {
    const el = [...document.querySelectorAll('#fbe-tree .fbe-name')]
      .find((e) => e.textContent === ${JSON.stringify(text)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!pt) return false;
  await S('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 120));
  return true;
}

async function openFixture(query, page = '/wiki/TESTTOKEN') {
  await S('Page.navigate', { url: `${BASE}${page}?${query}` });
  const t0 = Date.now();
  while (Date.now() - t0 < PAGE_TIMEOUT_MS) {
    const r = value(await S('Runtime.evaluate', { expression: 'window.__ready', returnByValue: true }));
    if (r === true) return true;
    if (typeof r === 'string' && r.startsWith('ERR:')) throw new Error(`夹具自报失败：${r}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('夹具就绪超时');
}

const CB = '#fbe-tree input[type=checkbox]';
const treeState = () => evalJS(`(() => {
  const bs=[...document.querySelectorAll('${CB}')];
  const ls=[...document.getElementById('fbe-tree').children];
  return {
    total: bs.length,
    checked: bs.filter(b=>b.checked).length,
    indeterminate: bs.filter(b=>b.indeterminate).length,
    disabled: bs.filter(b=>b.disabled).length,
    depth: ls.map(l=>Math.round((parseFloat(l.style.paddingLeft)-14)/16)),
    visible: ls.filter(l=>!l.hidden).length,
    count: document.getElementById('fbe-count').textContent,
    logFirst: document.getElementById('fbe-log').textContent.charCodeAt(0),
    logLines: document.getElementById('fbe-log').children.length,
  };
})()`);
const uncheckAll = () => evalJS(`(() => { document.querySelectorAll('${CB}').forEach(b=>{b.checked=false}); return true; })()`);

// ───────────────────────── 断言 ─────────────────────────
const results = [];
const check = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });

try {
  await openFixture('st=main&lang=zh_CN');

  // 找一个「可导出且有后代」的行做级联目标。
  // 别挑目录行：目录按设计是 disabled 的（pickFormat 对文件夹返回 null），点它本就没反应。
  const rows = await evalJS(`(() => {
    const ls=[...document.getElementById('fbe-tree').children];
    const bs=[...document.querySelectorAll('${CB}')];
    return ls.map((l,i)=>({ i, disabled: bs[i].disabled,
      title:(l.querySelector('.fbe-name')||{}).textContent,
      titleAttr:l.title,
      kind:(l.querySelector('.fbe-kind')||{}).textContent }));
  })()`);
  const folderRow = rows.find((r) => r.kind === '目录');
  check('目录行解释的是「目录不能导出」，而不是内部类型号',
    folderRow && folderRow.titleAttr === ZH.notExportableFolder.message,
    `"${folderRow ? folderRow.titleAttr : '无目录行'}"`);
  const d = (await treeState()).depth;
  let pIdx = -1;
  for (let i = 0; i < d.length - 1; i++) if (d[i + 1] > d[i] && !rows[i].disabled) { pIdx = i; break; }
  const end = (() => { let j = pIdx + 1; while (j < d.length && d[j] > d[pIdx]) j++; return j; })();
  const kids = end - pIdx - 1;

  const s0 = await treeState();
  check('夹具把真实 content.js 渲染出列表', s0.total > 0, `checkbox=${s0.total}`);
  check('导不出的类型（目录/思维笔记）不给勾', s0.disabled > 0, `disabled 行=${s0.disabled}`);
  check('树里存在「可导出且带子文档」的行', pIdx >= 0, `#${pIdx}「${rows[pIdx]?.title}」(${rows[pIdx]?.kind}) 后代=${kids}`);
  const listLog = await evalJS(`document.getElementById('fbe-log').textContent`);
  const expectedListLog = ZH.listDoneExportable.message.replace('$1', '11').replace('$2', '7');
  check('列表日志说明总数里有多少可导出', listLog.includes(expectedListLog),
    `"${listLog}" 期望含 "${expectedListLog}"`);

  if (pIdx >= 0) {
    await uncheckAll();
    await realClick(pIdx + 1);
    let s = await treeState();
    check('单击只影响被点的那一行', s.checked === 1, `checked=${s.checked}`);

    await uncheckAll();
    await realClick(pIdx, 1); // Alt
    s = await treeState();
    check('Alt+单击只作用于自己，不级联', s.checked === 1, `checked=${s.checked}（后代有 ${kids} 个）`);

    await uncheckAll();
    await realClick(pIdx, 0);
    s = await treeState();
    check('单击目录连带勾上全部后代', s.checked === kids + 1, `checked=${s.checked} 期望=${kids + 1}`);

    await uncheckAll();
    await realClick(end - 1); // 只勾最深的那个后代
    s = await treeState();
    check('只勾深层后代时祖先呈半选', s.indeterminate >= 1, `indeterminate=${s.indeterminate}`);
  }

  // 目录名是组选择入口：勾/清它下面的可导出后代，但目录本身永远不进入勾选
  const folder = rows.find((r) => r.kind === '目录' && r.i < d.length - 1 && d[r.i + 1] > d[r.i]);
  if (folder) {
    let folderEnd = folder.i + 1;
    while (folderEnd < d.length && d[folderEnd] > d[folder.i]) folderEnd++;
    const folderDesc = rows.slice(folder.i + 1, folderEnd).filter((r) => !r.disabled).length;
    await uncheckAll();
    const clicked = await realClickName(folder.title);
    const sGroup = await treeState();
    const folderBox = await evalJS(`(() => {
      const b=document.querySelectorAll('${CB}')[${folder.i}];
      return { checked:b.checked, disabled:b.disabled, indeterminate:b.indeterminate };
    })()`);
    check('点目录名选中全部可导出后代，目录自身仍不可勾',
      clicked && sGroup.checked === folderDesc && folderBox.disabled
        && !folderBox.checked && folderBox.indeterminate,
      `clicked=${clicked} checked=${sGroup.checked} 期望=${folderDesc} box=${JSON.stringify(folderBox)}`);
    await realClickName(folder.title);
    const sGroup2 = await treeState();
    const folderBox2 = await evalJS(`document.querySelectorAll('${CB}')[${folder.i}].indeterminate`);
    check('再点目录名清空该目录的选择',
      sGroup2.checked === 0 && !folderBox2,
      `checked=${sGroup2.checked} folder.indeterminate=${folderBox2}`);

    // 筛选时目录组也只选可见项，不能把被筛掉的文档偷偷带上
    await evalJS(`(() => { const q=document.getElementById('fbe-q'); q.value='登录'; q.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
    await new Promise((r) => setTimeout(r, 150));
    const visibleDesc = await evalJS(`(() => {
      const lines=document.getElementById('fbe-tree').children;
      const boxes=document.querySelectorAll('${CB}');
      let n=0;
      for (let j=${folder.i + 1}; j<${folderEnd}; j++) {
        if (!lines[j].hidden && !boxes[j].disabled) n++;
      }
      return n;
    })()`);
    await realClickName(folder.title);
    const sFilteredGroup = await treeState();
    check('筛选后点目录名只选可见文档',
      sFilteredGroup.checked === visibleDesc && visibleDesc > 0 && visibleDesc < folderDesc,
      `checked=${sFilteredGroup.checked} visible=${visibleDesc} all=${folderDesc}`);
    await evalJS(`(() => { const q=document.getElementById('fbe-q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
    await new Promise((r) => setTimeout(r, 150));
    const sAfterClear = await treeState();
    check('清掉筛选后没有偷偷选中被隐藏的文档',
      sAfterClear.checked === visibleDesc, `checked=${sAfterClear.checked} 期望=${visibleDesc}`);
  }

  await uncheckAll();
  await evalJS(`document.getElementById('fbe-all').click()`);
  const sAll = await treeState();
  check('「全选」只覆盖可导出的行（不碰 disabled）', sAll.checked === sAll.total - sAll.disabled,
    `checked=${sAll.checked} 可导出=${sAll.total - sAll.disabled}`);

  // 过滤：只管显示，不碰勾选
  const beforeFilter = (await treeState()).checked;
  await evalJS(`(() => { const q=document.getElementById('fbe-q'); q.value='登录'; q.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const sFilt = await treeState();
  check('过滤不改变勾选状态', sFilt.checked === beforeFilter, `${beforeFilter} -> ${sFilt.checked}`);
  check('过滤确实收窄了可见行', sFilt.visible < sFilt.total, `visible=${sFilt.visible}/${sFilt.total}`);
  const filtLabel = await evalJS(`document.getElementById('fbe-all-label').textContent`);
  check('筛选时「全选」标签写明只作用于筛选结果',
    filtLabel === ZH.selectAllFiltered.message, `"${filtLabel}"`);
  await evalJS(`(() => { const q=document.getElementById('fbe-q'); q.value='zzz不存在的标题'; q.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const sNone = await evalJS(`(() => ({
    emptyShown: !document.getElementById('fbe-empty').hidden,
    text: document.getElementById('fbe-empty').textContent }))()`);
  check('无匹配时给出空态提示', sNone.emptyShown && sNone.text.length > 0, `"${sNone.text}"`);
  await evalJS(`(() => { const q=document.getElementById('fbe-q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const resetLabel = await evalJS(`document.getElementById('fbe-all-label').textContent`);
  check('清空筛选后「全选」标签恢复', resetLabel === ZH.selectAll.message, `"${resetLabel}"`);

  // 日志首行不该带换行（logHasLines 的回归点）
  const sLog = await treeState();
  check('日志首字符不是换行', sLog.logFirst !== 10, `首字符码=${sLog.logFirst}（10 即换行）`);

  // 重新扫描：checkbox 缓存必须作废，否则级联会写到已脱离文档的旧节点上，
  // 表现为「点了没反应」——所以判据是「级联后当前 DOM 上的后代真的被勾上了」，
  // 而不是去比较两次 querySelectorAll 的结果（那永远相等，测不出任何东西）。
  await evalJS(`document.getElementById('fbe-scan').click()`);
  for (let i = 0; i < 150; i++) {
    if (await evalJS(`!document.getElementById('fbe-scan').disabled`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const d2 = (await treeState()).depth;
  const rows2 = await evalJS(`(() => [...document.querySelectorAll('${CB}')].map(b=>b.disabled))()`);
  let p2 = -1;
  for (let i = 0; i < d2.length - 1; i++) if (d2[i + 1] > d2[i] && !rows2[i]) { p2 = i; break; }
  const end2 = (() => { let j = p2 + 1; while (j < d2.length && d2[j] > d2[p2]) j++; return j; })();

  // 用「数调用次数」而不是「测耗时」来守住缓存：计时会因 CI 机器快慢而假红，
  // 而把 querySelectorAll 计数是确定的。renderTree 只清子节点、不换 #fbe-tree
  // 这个元素本身，所以打在它身上的计数能覆盖后面的交互。
  await evalJS(`(() => {
    const tree = document.getElementById('fbe-tree');
    window.__qsa = 0;
    const orig = tree.querySelectorAll.bind(tree);
    tree.querySelectorAll = function (...a) { window.__qsa++; return orig(...a); };
    return true;
  })()`);
  await uncheckAll();
  await realClick(p2); // 重扫后立刻级联 —— 一次交互会问好几遍 checkbox 列表
  const sRescan = await treeState();
  check('重扫后级联仍能写到当前 DOM（缓存已作废）', sRescan.checked === (end2 - p2),
    `checked=${sRescan.checked} 期望=${end2 - p2}（自己+后代）`);

  const qsa = await evalJS(`window.__qsa`);
  check('一次级联交互不会反复全树查询（checkbox 有缓存）', qsa <= 1,
    `querySelectorAll 被调 ${qsa} 次（缓存失效时会 ≥3 次）`);

  // 切语言会 rebuildPanel：缓存/日志标记都要跟着走
  const beforeLang = await treeState();
  await evalJS(`(() => { const l=document.getElementById('fbe-lang'); l.value='en'; l.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await new Promise((r) => setTimeout(r, 900));
  const afterLang = await evalJS(`(() => ({
    lang: document.getElementById('fbe-lang').value,
    logFirst: document.getElementById('fbe-log').textContent.charCodeAt(0),
    count: document.getElementById('fbe-count').textContent,
    checked: [...document.querySelectorAll('${CB}')].filter(b=>b.checked).length,
  }))()`);
  check('切语言后面板重建完成', afterLang.lang === 'en', `lang=${afterLang.lang}`);
  check('重建后日志首行不多出换行', afterLang.logFirst !== 10, `首字符码=${afterLang.logFirst}`);
  check('重建后勾选状态得以保留', afterLang.checked === beforeLang.checked, `${beforeLang.checked} -> ${afterLang.checked}`);
  await uncheckAll();
  const idxEn = await evalJS(`[...document.querySelectorAll('${CB}')].findIndex(b=>!b.disabled)`);
  await realClick(idxEn);
  check('重建后的 checkbox 可正常响应（缓存没串面板）', (await treeState()).checked >= 1, `点了 #${idxEn}`);

  // 切语言后，通过 chrome.runtime.onMessage 触发 fbe-toggle，面板依然能正常关闭和打开
  // （守住 buildPanel 重复注册 onMessage 监听器导致的竞争/反跳问题）
  const listenerCount = await evalJS(`window.chrome.runtime.onMessage._listeners.length`);
  check('切语言后面板不重复注册 onMessage 监听器', listenerCount === 1, `listeners=${listenerCount}`);
  await evalJS(`window.__panelToggle({ type: 'fbe-toggle' })`);
  const toggledClosed = await evalJS(`document.getElementById('fbe-panel').hidden && !document.getElementById('fbe-fab').hidden`);
  check('切语言后工具栏消息仍可关上面板', toggledClosed, `hidden=${toggledClosed}`);
  await evalJS(`window.__panelToggle({ type: 'fbe-toggle' })`);
  const toggledOpen = await evalJS(`!document.getElementById('fbe-panel').hidden && document.getElementById('fbe-fab').hidden`);
  check('切语言后工具栏消息仍可重新打开面板', toggledOpen, `open=${toggledOpen}`);

  // 面板不该横向溢出视口
  const fit = await evalJS(`(() => {
    const p=document.getElementById('fbe-panel').getBoundingClientRect();
    const bad=[];
    document.querySelectorAll('#fbe-panel *').forEach(el=>{
      const r=el.getBoundingClientRect();
      if (r.width && r.height && (r.right > p.right+1 || r.left < p.left-1)) {
        bad.push((el.id||el.className||el.tagName)+''); }
    });
    return { w:Math.round(p.width), h:Math.round(p.height), vw:innerWidth, vh:innerHeight, bad };
  })()`);
  check('面板内没有元素横向溢出面板边界', fit.bad.length === 0, fit.bad.join(', ') || '无');
  check('面板高度不超出视口', fit.h <= fit.vh, `${fit.h} <= ${fit.vh}`);

  // 运行态：主键让位给停止
  await evalJS(`(() => { const s=document.getElementById('fbe-scan'); s.click(); return true; })()`);
  for (let i = 0; i < 150; i++) {
    if (await evalJS(`!document.getElementById('fbe-scan').disabled`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await evalJS(`(() => { const i=[...document.querySelectorAll('${CB}')].findIndex(b=>!b.disabled); document.querySelectorAll('${CB}')[i].click(); document.getElementById('fbe-start').click(); return true; })()`);
  await new Promise((r) => setTimeout(r, 800));
  const runState = await evalJS(`(() => ({
    startHidden: document.getElementById('fbe-start').hidden,
    stopVisible: !document.getElementById('fbe-stop').hidden,
    scanDisabled: document.getElementById('fbe-scan').disabled,
    progress: document.getElementById('fbe-progress-text').textContent,
  }))()`);
  check('运行中：开始按钮让位给停止', runState.startHidden && runState.stopVisible,
    `start.hidden=${runState.startHidden} stop.visible=${runState.stopVisible}`);
  check('运行中：重新列出被禁用', runState.scanDisabled, `scan.disabled=${runState.scanDisabled}`);
  check('运行中：进度有读数', /\d+\s*\/\s*\d+/.test(runState.progress), `"${runState.progress}"`);

  // 收掉这次运行，给后面的重扫测试一个干净起点
  await evalJS(`document.getElementById('fbe-stop').click()`);
  for (let i = 0; i < 100; i++) {
    if (await evalJS(`document.getElementById('fbe-stop').hidden`)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // 在知识库页列出「我的云空间」，收起再打开：下拉必须仍指向云空间。
  // 只按 URL 猜来源会写回「当前知识库」，和树里的内容对不上。
  await evalJS(`(() => {
    const s=document.getElementById('fbe-src'); s.value='drive';
    s.dispatchEvent(new Event('change',{bubbles:true}));
    document.getElementById('fbe-scan').click();
    return true;
  })()`);
  for (let i = 0; i < 150; i++) {
    const ok = await evalJS(`!document.getElementById('fbe-scan').disabled
      && document.querySelectorAll('#fbe-tree > div').length === 5`);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  await evalJS(`window.__panelToggle()`); // 收起
  await evalJS(`window.__panelToggle()`); // 再打开
  await new Promise((r) => setTimeout(r, 300));
  const reopened = await evalJS(`({
    src: document.getElementById('fbe-src').value,
    first: (document.querySelector('#fbe-tree .fbe-name')||{}).textContent,
  })`);
  check('重开面板后来源仍对应已列出的云空间列表',
    reopened.src === 'drive' && reopened.first === '我的文档',
    `src=${reopened.src} first="${reopened.first}"`);

  // 只切到 URL 模式、还没列出时，重开/换语言都不能让来源说 URL、树却是云空间
  await evalJS(`(() => {
    const s=document.getElementById('fbe-src'); s.value='urls';
    s.dispatchEvent(new Event('change',{bubbles:true})); return true;
  })()`);
  await evalJS(`window.__panelToggle()`);
  await evalJS(`window.__panelToggle()`);
  await new Promise((r) => setTimeout(r, 300));
  const urlReopen = await evalJS(`({
    src: document.getElementById('fbe-src').value,
    first: (document.querySelector('#fbe-tree .fbe-name')||{}).textContent,
  })`);
  check('切到 URL 模式但未列出时，重开仍显示列表真实来源',
    urlReopen.src === 'drive' && urlReopen.first === '我的文档',
    `src=${urlReopen.src} first="${urlReopen.first}"`);

  await evalJS(`(() => {
    const s=document.getElementById('fbe-src'); s.value='urls';
    s.dispatchEvent(new Event('change',{bubbles:true})); return true;
  })()`);
  await evalJS(`(() => { const l=document.getElementById('fbe-lang'); l.value='en'; l.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
  await new Promise((r) => setTimeout(r, 800));
  const urlLang = await evalJS(`({
    src: document.getElementById('fbe-src').value,
    first: (document.querySelector('#fbe-tree .fbe-name')||{}).textContent,
  })`);
  check('切到 URL 模式后换语言，来源仍跟随列表',
    urlLang.src === 'drive' && urlLang.first === '我的文档',
    `src=${urlLang.src} first="${urlLang.first}"`);

  // SPA 导航到不会自动重列的页面（云空间首页）：来源继续跟随可见树
  await openFixture('st=listed&lang=zh_CN');
  await evalJS(`history.pushState({}, '', '/drive/home')`);
  await evalJS(`window.__panelToggle()`);
  await evalJS(`window.__panelToggle()`);
  await new Promise((r) => setTimeout(r, 300));
  const spaSource = await evalJS(`({
    src: document.getElementById('fbe-src').value,
    first: (document.querySelector('#fbe-tree .fbe-name')||{}).textContent,
    rows: document.querySelectorAll('#fbe-tree > div').length,
  })`);
  check('SPA 导航到非自动列页面时来源仍跟随可见树',
    spaSource.src === 'wiki' && spaSource.first === '产品与设计' && spaSource.rows === 11,
    `src=${spaSource.src} first="${spaSource.first}" rows=${spaSource.rows}`);

  // URL 列表没有修改时间：按时间勾选必须禁用并说明，而不是白点一次清空选择
  await openFixture('st=listed&notime=1&lang=zh_CN');
  const noTime = await evalJS(`({
    disabled: document.getElementById('fbe-since').disabled,
    title: document.getElementById('fbe-since').title,
    rows: document.querySelectorAll('#fbe-tree > div').length,
  })`);
  check('没有修改时间时禁用「按修改时间勾选」并说明原因',
    noTime.disabled && noTime.rows === 11 && noTime.title === ZH.recentNoTime.message,
    `disabled=${noTime.disabled} rows=${noTime.rows} title="${noTime.title}"`);

  // 按时间勾选 0 命中会把所有勾选清空，此时「全选」也必须跟着取消勾选
  await openFixture('st=listed&old=1&lang=zh_CN');
  await evalJS(`document.getElementById('fbe-all').click()`);
  await new Promise((r) => setTimeout(r, 150));
  await evalJS(`(() => {
    const s=document.getElementById('fbe-since'); s.value='90';
    s.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const cleared = await evalJS(`(() => {
    const all=document.getElementById('fbe-all');
    return {
      checked: [...document.querySelectorAll('${CB}')].filter(b=>b.checked).length,
      allChecked: all.checked, allIndeterminate: all.indeterminate,
    };
  })()`);
  check('按时间勾选 0 命中后「全选」不保持勾选',
    cleared.checked === 0 && !cleared.allChecked && !cleared.allIndeterminate,
    `checked=${cleared.checked} all=${cleared.allChecked}/${cleared.allIndeterminate}`);

  // 新一轮列出必须清掉上一轮的进度条和重试按钮（旧失败原因已随日志一起清空）
  await openFixture('st=main&failall=1&lang=zh_CN');
  await evalJS(`document.getElementById('fbe-all').click()`);
  await evalJS(`document.getElementById('fbe-start').click()`);
  for (let i = 0; i < 300; i++) {
    if (await evalJS(`!document.getElementById('fbe-start').hidden`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const failedRun = await evalJS(`({
    retryHidden: document.getElementById('fbe-retry').hidden,
    progressHidden: document.getElementById('fbe-progress').hidden,
  })`);
  check('失败收尾后重试和进度都可见', !failedRun.retryHidden && !failedRun.progressHidden,
    `retry.hidden=${failedRun.retryHidden} progress.hidden=${failedRun.progressHidden}`);
  await evalJS(`(() => { const l=document.getElementById('fbe-lang'); l.value='en'; l.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
  await new Promise((r) => setTimeout(r, 800));
  const failedAfterLang = await evalJS(`({
    retryHidden: document.getElementById('fbe-retry').hidden,
    retryText: document.getElementById('fbe-retry').textContent,
    progressHidden: document.getElementById('fbe-progress').hidden,
  })`);
  check('失败收尾后换语言重试按钮和进度仍在',
    !failedAfterLang.retryHidden && failedAfterLang.retryText.length > 0 && !failedAfterLang.progressHidden,
    `retry.hidden=${failedAfterLang.retryHidden} retry="${failedAfterLang.retryText}" progress.hidden=${failedAfterLang.progressHidden}`);
  await evalJS(`document.getElementById('fbe-scan').click()`);
  for (let i = 0; i < 150; i++) {
    const ok = await evalJS(`!document.getElementById('fbe-scan').disabled
      && document.querySelectorAll('#fbe-tree > div').length === 11`);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const afterRescan = await evalJS(`({
    retryHidden: document.getElementById('fbe-retry').hidden,
    progressHidden: document.getElementById('fbe-progress').hidden,
  })`);
  check('重新列出后上一轮的重试和进度不再残留',
    afterRescan.retryHidden && afterRescan.progressHidden,
    `retry.hidden=${afterRescan.retryHidden} progress.hidden=${afterRescan.progressHidden}`);

  // 键盘/辅助技术触发的是 detail=0 的 click（不是 pointer 事件），浮标也必须能开
  await evalJS(`window.__panelToggle()`); // 先收起
  await evalJS(`(() => {
    const fab=document.getElementById('fbe-fab'); fab.focus(); fab.click(); return true;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  check('键盘/辅助技术能打开浮标',
    !(await evalJS(`document.getElementById('fbe-panel').hidden`)),
    'detail=0 click 后面板应展开');

  // 筛选框里的 Esc 是「清空搜索」，不是「关面板」
  const labelBeforeEsc = await evalJS(`document.getElementById('fbe-all-label').textContent`);
  await evalJS(`(() => {
    const q=document.getElementById('fbe-q'); q.value='登录';
    q.dispatchEvent(new Event('input',{bubbles:true})); q.focus(); return true;
  })()`);
  await S('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await new Promise((r) => setTimeout(r, 200));
  const escState = await evalJS(`({
    hidden: document.getElementById('fbe-panel').hidden,
    q: document.getElementById('fbe-q').value,
    label: document.getElementById('fbe-all-label').textContent,
  })`);
  check('筛选框里的 Esc 只清空筛选，不关面板',
    !escState.hidden && escState.q === '' && escState.label === labelBeforeEsc,
    `hidden=${escState.hidden} q="${escState.q}" label="${escState.label}" 期望恢复 "${labelBeforeEsc}"`);

  // 列出中换语言：不能把「正在列出」换成开场白，也不能放开重复扫描
  await openFixture('st=listing&freeze=1&lang=zh_CN');
  for (let i = 0; i < 100; i++) {
    if (await evalJS(`document.getElementById('fbe-scan').disabled`)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await evalJS(`(() => { const l=document.getElementById('fbe-lang'); l.value='en'; l.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
  await new Promise((r) => setTimeout(r, 800));
  const scanAfterLang = await evalJS(`({
    scanDisabled: document.getElementById('fbe-scan').disabled,
    startDisabled: document.getElementById('fbe-start').disabled,
    qDisabled: document.getElementById('fbe-q').disabled,
    emptyVisible: !document.getElementById('fbe-empty').hidden,
    emptyText: document.getElementById('fbe-empty').textContent,
  })`);
  check('列出中换语言后仍显示进行中且不能重复发起',
    scanAfterLang.scanDisabled && scanAfterLang.startDisabled && scanAfterLang.qDisabled
      && scanAfterLang.emptyVisible && scanAfterLang.emptyText.length > 0,
    `scan.disabled=${scanAfterLang.scanDisabled} start.disabled=${scanAfterLang.startDisabled} q.disabled=${scanAfterLang.qDisabled} empty="${scanAfterLang.emptyText}"`);

  // 导出中换语言：进度和「停止」不能消失（后台还在跑）
  await openFixture('st=main&freeze=1&lang=zh_CN');
  await evalJS(`document.getElementById('fbe-all').click()`);
  await evalJS(`document.getElementById('fbe-start').click()`);
  for (let i = 0; i < 100; i++) {
    if (!(await evalJS(`document.getElementById('fbe-stop').hidden`))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 2200)); // 至少完成一篇，进度有读数
  await evalJS(`(() => { const l=document.getElementById('fbe-lang'); l.value='en'; l.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
  await new Promise((r) => setTimeout(r, 800));
  const runAfterLang = await evalJS(`({
    stopHidden: document.getElementById('fbe-stop').hidden,
    startHidden: document.getElementById('fbe-start').hidden,
    progressHidden: document.getElementById('fbe-progress').hidden,
    progressText: document.getElementById('fbe-progress-text').textContent,
    scanDisabled: document.getElementById('fbe-scan').disabled,
    focus: (document.activeElement || {}).id,
  })`);
  check('导出中换语言后停止和进度仍在',
    !runAfterLang.stopHidden && runAfterLang.startHidden
      && !runAfterLang.progressHidden && /\d+\s*\/\s*\d+/.test(runAfterLang.progressText)
      && runAfterLang.scanDisabled,
    `stop.hidden=${runAfterLang.stopHidden} start.hidden=${runAfterLang.startHidden} progress.hidden=${runAfterLang.progressHidden} "${runAfterLang.progressText}" scan.disabled=${runAfterLang.scanDisabled}`);
  check('换语言后面板重建仍把焦点留在语言选择器上',
    runAfterLang.focus === 'fbe-lang', `focus=${runAfterLang.focus}`);
  await evalJS(`document.getElementById('fbe-stop').click()`);
  for (let i = 0; i < 100; i++) {
    if (await evalJS(`document.getElementById('fbe-stop').hidden`)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // 还没列出文档时筛选没有对象：不能把「选好来源」提示改成「没有标题匹配」
  await openFixture('st=empty&lang=zh_CN', '/drive/home');
  await new Promise((r) => setTimeout(r, 300));
  const emptyState = await evalJS(`({
    panelHidden: document.getElementById('fbe-panel').hidden,
    qDisabled: document.getElementById('fbe-q').disabled,
    rows: document.querySelectorAll('#fbe-tree > div').length,
  })`);
  check('还没列出文档时筛选框不可用',
    !emptyState.panelHidden && emptyState.qDisabled && emptyState.rows === 0,
    `panel.hidden=${emptyState.panelHidden} q.disabled=${emptyState.qDisabled} rows=${emptyState.rows}`);
  await evalJS(`document.getElementById('fbe-scan').click()`);
  for (let i = 0; i < 100; i++) {
    if (await evalJS(`!document.getElementById('fbe-scan').disabled
      && document.querySelectorAll('#fbe-tree > div').length === 5`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  check('列出之后筛选框恢复可用',
    !(await evalJS(`document.getElementById('fbe-q').disabled`)),
    'rows=5 后 q.disabled 应为 false');

  // 停止后已完成的条目不参与下一轮：再点开始只处理剩下的
  await openFixture('st=stopped&lang=zh_CN');
  const stoppedState = await evalJS(`(() => {
    const boxes=[...document.querySelectorAll('${CB}')];
    return {
      checked: boxes.filter(b=>b.checked).length,
      firstDone: !boxes[1].checked,
      restStillChecked: boxes[2].checked && boxes[3].checked,
      startHidden: document.getElementById('fbe-start').hidden,
      progress: document.getElementById('fbe-progress-text').textContent,
      log: document.getElementById('fbe-log').textContent,
    };
  })()`);
  check('停止后已完成的条目取消勾选，剩下的保持勾选',
    stoppedState.checked === 6 && stoppedState.firstDone && stoppedState.restStillChecked
      && !stoppedState.startHidden,
    `checked=${stoppedState.checked} firstDone=${stoppedState.firstDone} rest=${stoppedState.restStillChecked} start.hidden=${stoppedState.startHidden} "${stoppedState.progress}"`);
  check('停止后的收尾日志不冒充「导出完成」',
    stoppedState.log.includes(ZH.doneZipPartial.message.split('$1')[0])
      && !stoppedState.log.includes('导出完成'),
    stoppedState.log.replace(/\n/g, ' / '));
  await evalJS(`(() => { const l=document.getElementById('fbe-lang'); l.value='en'; l.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
  await new Promise((r) => setTimeout(r, 800));
  const stoppedAfterLang = await evalJS(`({
    progressHidden: document.getElementById('fbe-progress').hidden,
    progressText: document.getElementById('fbe-progress-text').textContent,
  })`);
  check('停止结果换语言后仍保留进度读数',
    !stoppedAfterLang.progressHidden && /\d+\s*\/\s*\d+/.test(stoppedAfterLang.progressText),
    `progress.hidden=${stoppedAfterLang.progressHidden} "${stoppedAfterLang.progressText}"`);

  // 空文件夹列出 0 项后，空态应说明结果，而不是再邀请一次「点列出文档」
  await openFixture('st=fab&lang=zh_CN', '/drive/folder/EMPTY');
  await evalJS(`window.__panelToggle()`);
  for (let i = 0; i < 100; i++) {
    const ok = await evalJS(`!document.getElementById('fbe-scan').disabled
      && /列出 0 项/.test(document.getElementById('fbe-log').textContent)`);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const emptyFolder = await evalJS(`({
    hidden: document.getElementById('fbe-empty').hidden,
    text: document.getElementById('fbe-empty').textContent,
    qDisabled: document.getElementById('fbe-q').disabled,
  })`);
  check('空文件夹列出 0 项后给出「没有文档」而不是重复邀请',
    !emptyFolder.hidden && emptyFolder.text === ZH.emptyNoDocs.message && emptyFolder.qDisabled,
    `hidden=${emptyFolder.hidden} text="${emptyFolder.text}" q.disabled=${emptyFolder.qDisabled}`);
  await evalJS(`window.__panelToggle()`);
  await evalJS(`window.__panelToggle()`);
  await new Promise((r) => setTimeout(r, 300));
  const emptyReopen = await evalJS(`({
    hidden: document.getElementById('fbe-empty').hidden,
    text: document.getElementById('fbe-empty').textContent,
    src: document.getElementById('fbe-src').value,
  })`);
  check('空文件夹结果收起再开仍保留',
    !emptyReopen.hidden && emptyReopen.text === ZH.emptyNoDocs.message
      && emptyReopen.src === 'folder',
    `hidden=${emptyReopen.hidden} text="${emptyReopen.text}" src=${emptyReopen.src}`);

  // 来源自动切换（选错来源后点列出）不能把「正在列出…」擦成开场白
  await openFixture('st=empty&lang=zh_CN&slow=1', '/drive/home');
  await evalJS(`(() => {
    const s=document.getElementById('fbe-src'); s.value='wiki';
    s.dispatchEvent(new Event('change',{bubbles:true})); return true;
  })()`);
  await evalJS(`document.getElementById('fbe-scan').click()`);
  await new Promise((r) => setTimeout(r, 200));
  const autoSwitch = await evalJS(`({
    src: document.getElementById('fbe-src').value,
    empty: document.getElementById('fbe-empty').textContent,
    busy: document.getElementById('fbe-empty').classList.contains('busy'),
    scanDisabled: document.getElementById('fbe-scan').disabled,
  })`);
  check('来源自动切换时仍显示「正在列出」',
    autoSwitch.src === 'drive' && autoSwitch.empty === ZH.listing.message
      && autoSwitch.busy && autoSwitch.scanDisabled,
    `src=${autoSwitch.src} empty="${autoSwitch.empty}" busy=${autoSwitch.busy} scan.disabled=${autoSwitch.scanDisabled}`);
  for (let i = 0; i < 100; i++) {
    if (await evalJS(`!document.getElementById('fbe-scan').disabled`)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
} catch (e) {
  check('检查过程未抛异常', false, e.message);
}

// ───────────────────────── 收尾 ─────────────────────────
const pass = results.filter((r) => r.pass).length;
for (const r of results) {
  console.log(`${r.pass ? '✔' : '✖'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log(`\nUI 回归：${pass}/${results.length} 通过`);

await send('Target.closeTarget', { targetId: tgt.result.targetId }).catch(() => {});
ws.close();
cleanup();
process.exit(pass === results.length ? 0 : 1);