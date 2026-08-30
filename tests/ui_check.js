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
  const downloads = [];
  page.on('console', function (m) { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', function (e) { errors.push(String(e)); });
  page.on('download', function (d) { downloads.push(d.suggestedFilename()); });

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
  await page.waitForTimeout(2500);
  const summary = await page.textContent('#cand-summary');
  console.log('cand-summary =', summary.trim());

  // 3. 挑一家未命中库的公司完成校验并输出
  const cards = await page.$$('.card');
  let done = false;
  for (const card of cards) {
    const badge = await card.$eval('.badge', function (el) { return el.textContent; });
    if (badge.indexOf('✔ 可输出') !== -1 || badge.indexOf('待校验') !== -1) {
      const id = await card.getAttribute('data-id');
      // 逐字输入公司名并删除，验证输入框可连续输入（防止整列表重绘导致无法输入）
      const nameInput = '.card[data-id="' + id + '"] .in-name';
      const origName = await page.inputValue(nameInput);
      await page.click(nameInput);
      await page.keyboard.type('A', { delay: 30 });
      await page.keyboard.press('End');
      await page.keyboard.press('Backspace');
      const nameAfter = await page.inputValue(nameInput);
      if (nameAfter !== origName) throw new Error('名称输入框无法连续输入');
      await page.click('.card[data-id="' + id + '"] button:has-text("验证")');
      await page.waitForTimeout(400);
      const btnText = await page.textContent('.card[data-id="' + id + '"] button:has-text("验证")');
      if (btnText.indexOf('重新验证') === -1 && btnText.indexOf('AI 验证') === -1) {
        throw new Error('验证按钮状态异常：' + btnText);
      }
      // 自动初筛无法确认的项（如①存续、④双源），人工补充勾选后输出
      const left = await page.$$('.card[data-id="' + id + '"] .r3 input[type=checkbox]');
      for (const ch of left) {
        if (!(await ch.isChecked())) await ch.click();
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

  // 4. 一键导出初筛名单
  await page.click('button:has-text("导出初筛名单(制表符文本)")');
  await page.waitForTimeout(800);
  const tsvFiles = downloads.filter(function (n) { return n.endsWith('.txt'); });
  if (!tsvFiles.length) throw new Error('未触发制表符文本下载');
  console.log('TSV_DOWNLOAD', tsvFiles[0]);
  await page.click('button:has-text("导出初筛名单(Excel)")');
  await page.waitForTimeout(5000); // 等待在线加载 Excel 组件
  const xlsxFiles = downloads.filter(function (n) { return n.endsWith('.xlsx'); });
  if (xlsxFiles.length) console.log('XLSX_DOWNLOAD', xlsxFiles[0]);
  else console.log('XLSX_DOWNLOAD_SKIPPED (组件未加载，逻辑已由单测验证)');

  await page.screenshot({ path: SHOT, fullPage: true });
  console.log('SCREENSHOT', SHOT);
  console.log('CONSOLE_ERRORS', JSON.stringify(errors));
  await browser.close();
})().catch(function (e) {
  console.error(e);
  process.exit(1);
});
