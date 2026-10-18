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

async function openFixture(query) {
  await S('Page.navigate', { url: `${BASE}/wiki/TESTTOKEN?${query}` });
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
      kind:(l.querySelector('.fbe-kind')||{}).textContent }));
  })()`);
  const d = (await treeState()).depth;
  let pIdx = -1;
  for (let i = 0; i < d.length - 1; i++) if (d[i + 1] > d[i] && !rows[i].disabled) { pIdx = i; break; }
  const end = (() => { let j = pIdx + 1; while (j < d.length && d[j] > d[pIdx]) j++; return j; })();
  const kids = end - pIdx - 1;

  const s0 = await treeState();
  check('夹具把真实 content.js 渲染出列表', s0.total > 0, `checkbox=${s0.total}`);
  check('导不出的类型（目录/思维笔记）不给勾', s0.disabled > 0, `disabled 行=${s0.disabled}`);
  check('树里存在「可导出且带子文档」的行', pIdx >= 0, `#${pIdx}「${rows[pIdx]?.title}」(${rows[pIdx]?.kind}) 后代=${kids}`);

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
  await evalJS(`(() => { const q=document.getElementById('fbe-q'); q.value='zzz不存在的标题'; q.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  const sNone = await evalJS(`(() => ({
    emptyShown: !document.getElementById('fbe-empty').hidden,
    text: document.getElementById('fbe-empty').textContent }))()`);
  check('无匹配时给出空态提示', sNone.emptyShown && sNone.text.length > 0, `"${sNone.text}"`);
  await evalJS(`(() => { const q=document.getElementById('fbe-q'); q.value=''; q.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);

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