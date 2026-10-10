#!/usr/bin/env node
/**
 * 桌面版 build pipeline（3.15.1）。
 *
 * 1. 由 hk-legal-dora/src 複製 TS 源碼到 web-src/（唯讀來源，一字不改；
 *    assert APP_VERSION，避免抄錯分支）。
 * 2. esbuild 打包：
 *    - desktop/desktop-entry.ts → src/desktop-bundle.js（IIFE；plugin 將
 *      web-src 內部的 './ui' import 指向 desktop/shims/ui.ts，
 *      等 openDownloadPopup 可以被 Tauri native 下載攔截）。
 *    - desktop/db/index.ts → src/db-layer.js（IIFE，global __TG_DB__；
 *      純 SQL 轉換層，唔掂 DOM）。
 * 3. HTML 殼：取 hk-legal-dora/dist/index.html，去掉 web IIFE bundle，
 *    換上 desktop script tags。
 *
 * 用法：node scripts/build-desktop.js [--no-copy] [--no-db]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// Mac source tarball 冇 hk-legal-dora，可用 env var 指去 tarball 內自帶嘅嘢：
//   TG_HK_SRC  → web-src 來源（tarball 內已附，設為 web-src 本身即跳過複製）
//   TG_HK_DIST → HTML 殼來源（tarball 內 desktop/desktop-shell.html）
const HK_SRC = process.env.TG_HK_SRC || '/home/hatch/workspace/hk-legal-dora/src';
const HK_DIST = process.env.TG_HK_DIST || '/home/hatch/workspace/hk-legal-dora/dist/index.html';
const WEB_SRC = path.join(ROOT, 'web-src');
const EXPECTED_VERSION = '3.15.1';

function assert(cond, msg) {
  if (!cond) { console.error('BUILD FAILED: ' + msg); process.exit(1); }
}

// ---- 1. 複製源碼 ----
if (!process.argv.includes('--no-copy')) {
  if (path.resolve(HK_SRC) === path.resolve(WEB_SRC)) {
    console.log('> 來源即 web-src 本身，跳過複製');
  } else {
  console.log('> 複製 hk-legal-dora/src → web-src/');
  assert(fs.existsSync(HK_SRC), 'hk-legal-dora/src 不存在：' + HK_SRC);
  fs.rmSync(WEB_SRC, { recursive: true, force: true });
  fs.cpSync(HK_SRC, WEB_SRC, { recursive: true });
  const verSrc = fs.readFileSync(path.join(WEB_SRC, 'version.ts'), 'utf8');
  const m = verSrc.match(/APP_VERSION\s*=\s*'([^']+)'/);
  assert(m && m[1] === EXPECTED_VERSION,
    `APP_VERSION 唔係 ${EXPECTED_VERSION}（係 ${m && m[1]}？分支錯咗？）`);
  console.log(`  APP_VERSION=${m[1]} ✓`);
  }
} else {
  console.log('> 跳過複製（--no-copy）');
}

// ---- 2. esbuild ----
const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));

// plugin：web-src 內部 `from './ui'` → desktop/shims/ui.ts（web-src 本體不改）
const uiShimPlugin = {
  name: 'tg-ui-shim',
  setup(build) {
    build.onResolve({ filter: /^\.\/ui$/ }, (args) => {
      if (args.importer.split(path.sep).includes('web-src')) {
        return { path: path.join(ROOT, 'desktop', 'shims', 'ui.ts') };
      }
      return null;
    });
  },
};

console.log('> esbuild desktop-entry.ts → src/desktop-bundle.js');
buildAll().catch((e) => { console.error('BUILD FAILED:', e.message); process.exit(1); });

async function buildAll() {
await esbuild.build({
  entryPoints: [path.join(ROOT, 'desktop', 'desktop-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  sourcemap: false,
  outfile: path.join(ROOT, 'src', 'desktop-bundle.js'),
  plugins: [uiShimPlugin],
  logLevel: 'warning',
});
assert(fs.existsSync(path.join(ROOT, 'src', 'desktop-bundle.js')), 'desktop-bundle.js 未產出');
console.log('  desktop-bundle.js ✓');

if (!process.argv.includes('--no-db')) {
  const dbIndex = path.join(ROOT, 'desktop', 'db', 'index.ts');
  assert(fs.existsSync(dbIndex), 'desktop/db/index.ts 未就緒（DB 層未完成）');
  console.log('> esbuild desktop/db/index.ts → src/db-layer.js');
  await esbuild.build({
    entryPoints: [dbIndex],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: false,
    sourcemap: false,
    globalName: '__TG_DB__',
    outfile: path.join(ROOT, 'src', 'db-layer.js'),
    logLevel: 'warning',
  });
  console.log('  db-layer.js ✓');
} else {
  console.log('> 跳過 db-layer（--no-db）');
}

// ---- 2.5 合併 glue 模組 ----
console.log('> 合併 src/glue/*.js → src/tauri-glue.js');
{
  const glueDir = path.join(ROOT, 'src', 'glue');
  const files = fs.readdirSync(glueDir).filter(f => f.endsWith('.js')).sort();
  let combined = '';
  for (const f of files) {
    combined += fs.readFileSync(path.join(glueDir, f), 'utf8') + '\n';
  }
  fs.writeFileSync(path.join(ROOT, 'src', 'tauri-glue.js'), combined);
  console.log('  合併 ' + files.length + ' 個模組，共 ' + combined.split('\n').length + ' 行');
}

// ---- 3. HTML 殼 ----
console.log('> 組裝 src/index.html（dist HTML 殼＋desktop scripts）');
assert(fs.existsSync(HK_DIST), 'hk-legal-dora/dist/index.html 不存在：' + HK_DIST);
const distHtml = fs.readFileSync(HK_DIST, 'utf8');
const openTag = '<script>';
const openIdx = distHtml.indexOf(openTag);
assert(openIdx !== -1, 'dist 內找不到 <script>');
const contentStart = openIdx + openTag.length;
const closeIdx = distHtml.indexOf('</script>', contentStart);
assert(closeIdx !== -1, 'dist 內找不到 </script>');
const afterClose = distHtml.slice(closeIdx);
assert(/^\s*<\/script>\s*<\/body>\s*<\/html>\s*$/.test(afterClose),
  'dist script 尾部結構唔似預期，唔敢拆：' + JSON.stringify(afterClose.slice(0, 80)));

const out =
  distHtml.slice(0, openIdx) +
  '<script src="desktop-bundle.js"></script>' +
  '\n<script src="vendor/xlsx.full.min.js"></script>' +
  '\n<script src="vendor/jszip.min.js"></script>' +
  '\n<script src="db-layer.js"></script>' +
  '\n<script src="tauri-glue.js"></script>\n' +
  distHtml.slice(closeIdx + '</script>'.length);

const indexPath = path.join(ROOT, 'src', 'index.html');
if (fs.existsSync(indexPath) && !fs.existsSync(indexPath + '.v314.bak')) {
  fs.copyFileSync(indexPath, indexPath + '.v314.bak');
  console.log('  舊 src/index.html 已備份為 src/index.html.v314.bak');
}
fs.writeFileSync(indexPath, out);
// 桌面版 badge 顯示兩個版本：桌面版＋核心（web 邏輯）版本
const desktopVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const coreSrc = fs.readFileSync(path.join(WEB_SRC, 'version.ts'), 'utf8');
const coreM = coreSrc.match(/APP_VERSION\s*=\s*'([^']+)'/);
assert(coreM, '讀唔到 web-src/version.ts 嘅 APP_VERSION');
const coreVer = coreM[1];
let finalHtml = fs.readFileSync(indexPath, 'utf8');
const badgeRe = /<div class="version-badge" aria-label="[^"]*">[^<]*<\/div>/;
assert(badgeRe.test(finalHtml), 'badge 結構唔似預期，唔敢 patch 版本號');
finalHtml = finalHtml.replace(badgeRe,
  '<div class="version-badge" aria-label="系統版本 v' + desktopVer + '，核心 v' + coreVer + '">' +
  '<span>v' + desktopVer + '</span><span class="core-ver">核心 v' + coreVer + '</span></div>' +
  '<style>.version-badge{display:flex;flex-direction:column;gap:3px;align-items:center;line-height:1.25}' +
  '.version-badge .core-ver{font-size:9px;font-weight:400;opacity:.7;letter-spacing:.02em}' +
  /* 桌面版獨有響應式修復：簽名列按容器寬度自動換行（web 版 media query 只睇 viewport） */
  '.signatures{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}' +
  /* 桌面版獨有：工具條收起時隱藏 backup-tools */
  '.fiscal-bar.tg-collapsed .backup-tools{display:none}' +
  '.fiscal-bar .tg-toggle{margin-left:auto}</style>');
fs.writeFileSync(indexPath, finalHtml);
console.log('  badge 版本號 → v' + desktopVer + '＋核心 v' + coreVer);
console.log('  src/index.html ✓ (' + (out.length / 1024).toFixed(1) + ' KB)');

await runTypecheck();
console.log('BUILD OK');
} // end buildAll

async function runTypecheck() {
// ---- 4. 閘門 ----
console.log('> typecheck（tsc --noEmit）');
try {
  execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe' });
  console.log('  typecheck ✓ 零 error');
} catch (e) {
  console.error('BUILD FAILED: tsc 有 error');
  console.error((e.stdout || '').toString().slice(0, 3000));
  process.exit(1);
}
}
