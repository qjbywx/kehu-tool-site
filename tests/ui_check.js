'use strict';

// 真实浏览器端到端检查（开发用）：
//   node tests/ui_check.js [页面URL] [截图输出路径]
// 默认用 http://127.0.0.1:8765 打开（模拟 Pages 环境，需先启动静态服务器）；
// 也可传 file:///... 只做界面冒烟（此时“获取候选”不可用）。
// 需要工作目录内有 dedup_a.json 和 candidates.json。
const path = require('path');
const pw = require('C:/Users/qjj/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core');

const ROOT = path.join(__dirname, '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8765/index.html';
const SHOT = process.argv[3] || path.join(ROOT, '.ui_preview.png');

(async function () {
  const browser = await pw.chromium.launch({
    executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function (e) { errors.push(String(e)); });

  await page.goto(BASE);
  await page.waitForTimeout(600);

  const statA0 = await page.textContent('#stat-a');
  console.log('stat-a(初始) =', statA0.trim());
  if (statA0.indexOf('未载入') === -1) throw new Error('初始应显示未载入去重库A');

  // 1. 首次载入去重库A（本机 dedup_a.json）
  await page.setInputFiles('input[accept*=".xlsx"]', path.join(ROOT, 'dedup_a.json'));
  await page.waitForTimeout(500);
  const statA = await page.textContent('#stat-a');
  console.log('stat-a(载入后) =', statA.trim());

  // 2. 一键获取候选（HTTP 服务需提供 candidates.json）
  await page.click('#btn-fetch');
  await page.waitForTimeout(800);
  const summary = await page.textContent('#cand-summary');
  console.log('cand-summary =', summary.trim());

  // 3. 挑一家未命中库的公司完成校验并输出
  const cards = await page.$$('.card');
  let done = false;
  for (const card of cards) {
    const badge = await card.$eval('.badge', function (el) { return el.textContent; });
    if (badge.indexOf('✔ 可输出') !== -1 || badge.indexOf('待校验') !== -1) {
      const id = await card.getAttribute('data-id');
      const addr = await card.$eval('.in-addr', function (el) { return el.value; });
      if (!addr.trim()) {
        await page.fill('.card[data-id="' + id + '"] .in-addr', '北京市海淀区中关村');
      }
      for (const key of ['a', 'b', 'c', 'd', 'e']) {
        await page.evaluate(function (arg) { window.GRTUI.toggleCheck(arg.id, arg.key, true); }, { id: id, key: key });
      }
      await page.selectOption('.card[data-id="' + id + '"] .in-biz', '网络安全');
      await page.click('.card[data-id="' + id + '"] button:has-text("生成备注")');
      done = true;
      break;
    }
  }
  if (!done) throw new Error('没有找到可校验的候选卡片');

  await page.click('button:has-text("生成输出")');
  await page.waitForTimeout(400);
  const out = await page.inputValue('#out-text');
  console.log('OUTPUT_START');
  console.log(out);
  console.log('OUTPUT_END');

  await page.screenshot({ path: SHOT, fullPage: true });
  console.log('SCREENSHOT', SHOT);
  console.log('CONSOLE_ERRORS', JSON.stringify(errors));
  await browser.close();
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
