// 变异测试：故意改坏 content.js，确认检查真的会红。
// 「通过的测试如果抓不住回归就等于没写」——这个脚本就是用来证明确抓得住的。
//
// 用法：node test/ui/mutate.mjs
// 每个变异都跑 node --test test.mjs（纯函数层）和 test/ui/check-ui.mjs（DOM 层），
// 任何一个变红都算抓到；跑完还原，最后确认基线恢复全绿。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = path.join(ROOT, 'extension', 'content.js');
const UI_CHECK = path.join(ROOT, 'test', 'ui', 'check-ui.mjs');
const UNIT = path.join(ROOT, 'test.mjs');
const raw = readFileSync(TARGET, 'utf8');
// 本仓库是 CRLF，变异串按 \n 写会一个都匹配不上 —— 先按文件实际换行归一
const EOL = raw.includes('\r\n') ? '\r\n' : '\n';
const nl = (s) => s.replace(/\n/g, EOL);
const orig = raw;

const MUTATIONS = [
  {
    name: 'renderTree 不再作废 checkbox 缓存',
    from: 'invalidateBoxes(); // 下面的重建会换掉全部 checkbox',
    to: '// 变异：删掉作废',
  },
  {
    name: 'scan() 忘了重置 logHasLines',
    from: `$('fbe-log').textContent = '';
    logHasLines = false;`,
    to: `$('fbe-log').textContent = '';`,
  },
  {
    name: 'rowEnd 的表不再随 rows 失效',
    from: 'if (endsRows !== rows) {',
    to: 'if (false) {',
  },
  {
    name: 'checkboxes() 完全不缓存（退回每次全树查询）',
    from: "if (!boxCache) boxCache = Array.from($('fbe-tree').querySelectorAll('input[type=checkbox]'));",
    to: "boxCache = Array.from($('fbe-tree').querySelectorAll('input[type=checkbox]'));",
  },
  {
    // 这两条是「同一个需求写在两个调用点」，各自单独删都会被对方挡住：
    // rebuildPanel 里那次作废，紧接着的 renderTree 里还会再作废一次；
    // logHasLines 与日志 DOM 始终同步（只有 log() 置 true、只有 scan() 清日志并同时置 false），
    // 所以 rebuildPanel 里再赋一次必然是同值。
    // 留着是让不变量写在本地而不是靠远处历史，但别把它们当成有覆盖的代码。
    name: '[预期漏网] rebuildPanel 里的 logHasLines 同步（恒等赋值）',
    from: 'logHasLines = !!logText; // 内容是搬过来的，首行该不该带换行跟着它走',
    to: '// 变异：删掉同步',
    expectUncaught: true,
  },
  {
    name: '[预期漏网] rebuildPanel 里的 invalidateBoxes（与 renderTree 的重复）',
    from: `    invalidateBoxes();
    if (panel) panel.remove();`,
    to: '    if (panel) panel.remove();',
    expectUncaught: true,
  },
];

// 这行是防御性的、并且观测不到：logHasLines 与日志 DOM 始终同步
// （只有 log() 置 true、只有 scan() 清日志且同时置 false），
// 所以 rebuildPanel 里再赋一次必然是同值 —— 删掉它没有任何可观察后果。
// 留着是让不变量写在本地而不是靠远处的历史，但别把它当成有覆盖的代码。

function run(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: 300_000, cwd: ROOT });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const unitRun = () => { const r = run('node', ['--test', UNIT]); return { code: r.code, fails: (r.out.match(/^✖ /gm) || []).length, line: (r.out.match(/ℹ fail (\d+)/) || [])[1] }; };
const uiRun = () => { const r = run('node', [UI_CHECK]); const m = r.out.match(/UI 回归：(\d+)\/(\d+) 通过/); return { code: r.code, fails: (r.out.match(/^✖ /gm) || []).length, line: m ? m[0] : 'no-summary' }; };

console.log(`换行符: ${EOL === '\r\n' ? 'CRLF' : 'LF'}`);
const bU = unitRun(); const bI = uiRun();
console.log(`基线  单测: fail=${bU.line} 退出码=${bU.code}`);
console.log(`基线  UI: ${bI.line} 退出码=${bI.code}`);
if (bU.code !== 0 || bI.code !== 0) {
  console.error('\n基线就是红的，先修好再谈变异。');
  process.exit(1);
}
console.log('');

let allCaught = true;
let uncaughtExpected = 0;
for (const m of MUTATIONS) {
  const from = nl(m.from);
  if (!orig.includes(from)) {
    console.log(`?? ${m.name} —— 没找到待替换原文（代码可能已变），这条变异本身失效了`);
    allCaught = false;
    continue;
  }
  writeFileSync(TARGET, orig.replace(from, nl(m.to)), 'utf8');
  const u = unitRun(); const i = uiRun();
  writeFileSync(TARGET, orig, 'utf8');
  const caughtBy = [];
  if (u.code !== 0) caughtBy.push(`单测(fail=${u.line})`);
  if (i.code !== 0) caughtBy.push(`UI(${i.line})`);
  const caught = caughtBy.length > 0;
  if (m.expectUncaught) {
    uncaughtExpected++;
    console.log(`${caught ? '?' : '·'} ${m.name}`);
    console.log(caught ? '     → 竟然被抓到了（比预期更严，无害）' : '     → 如预期没抓到：两处写法互相遮挡，本就无可观察后果');
  } else {
    if (!caught) allCaught = false;
    console.log(`${caught ? '✔' : '✖'} ${m.name}`);
    console.log(`     被 ${caughtBy.join(' + ') || '谁都没抓到 —— 漏网了，得多加一条检查'}`);
  }
}

const aU = unitRun(); const aI = uiRun();
console.log(`\n还原后 单测: fail=${aU.line} 退出码=${aU.code}`);
console.log(`还原后 UI: ${aI.line} 退出码=${aI.code}`);
const restored = aU.code === 0 && aI.code === 0;
console.log(allCaught && restored
  ? '\n结论：每个变异都被至少一层抓到，且还原后两层都恢复全绿。'
  : '\n结论：有变异漏网，检查项需要加强。');
process.exit(allCaught && restored ? 0 : 1);