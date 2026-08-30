'use strict';

// 浏览器环境冒烟测试：node tests/test_dom_smoke.js
// 模拟 document/localStorage/fetch，跑通：
// 载入去重库A → 一键获取候选（云端AI查验自动应用）→ 输出 → 自动初筛 → 只查名字模式 → 曾用名重跑。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function makeEl(id) {
  return {
    id: id,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    scrollIntoView: function () {},
    select: function () {},
    setSelectionRange: function () {},
    remove: function () {},
    files: []
  };
}

const els = {};
[
  'note', 'stat-a', 'stat-b', 'stat-total', 'stat-counter',
  'cand-list', 'cand-summary', 'hist-list', 'cand-input',
  'out-count', 'out-text', 'dedup-paste', 'b-import-text',
  'ai-base', 'ai-key', 'ai-model', 'namecheck-input',
  'namecheck-result', 'namecheck-summary'
].forEach(function (id) { els[id] = makeEl(id); });

const store = {};
const xlsxCalls = [];
const cloudVerify = {
  a: { pass: true, reason: '官网可访问，未见注销字样' },
  b: { pass: true, reason: '现用法定全称' },
  d: { pass: true, reason: '搜索来源+官网双源' },
  e: { pass: true, reason: '实体研产属性' },
  checked_at: '2026-08-30 08:00'
};
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  URL: URL,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Map: Map,
  Set: Set,
  Object: Object,
  String: String,
  Array: Array,
  Number: Number,
  encodeURIComponent: encodeURIComponent,
  prompt: function () { return '测试新公司科技有限公司（新名）'; },
  confirm: function () { return true; },
  fetch: function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve({
          candidates: [
            { name: '北京云澳瑞驰科技有限公司', scope_hint: '生产、研发', bizline: '服务器/信创整机', source_url: 'https://dir.com/1' },
            {
              name: '测试新公司科技有限公司', scope_hint: '生产、研发、制造', bizline: '网络安全',
              source_url: 'https://www.example.com', verify: cloudVerify
            }
          ]
        });
      }
    });
  },
  XLSX: {
    utils: {
      json_to_sheet: function () { return {}; },
      book_new: function () { return { Sheets: {}, SheetNames: [] }; },
      book_append_sheet: function (wb, ws, name) { wb.SheetNames.push(name); wb.Sheets[name] = ws; }
    },
    writeFile: function (wb, name) { xlsxCalls.push(name); }
  },
  localStorage: {
    getItem: function (k) { return store[k] || null; },
    setItem: function (k, v) { store[k] = String(v); }
  },
  navigator: {},
  document: {
    getElementById: function (id) { return els[id] || null; },
    querySelector: function () { return null; },
    createElement: function () {
      const el = makeEl('dyn');
      el.click = function () {};
      return el;
    },
    body: { appendChild: function () {}, removeChild: function () {} },
    head: { appendChild: function () {} }
  },
  window: { open: function () {}, isSecureContext: false },
  URL: {
    createObjectURL: function () { return 'blob:mock'; },
    revokeObjectURL: function () {}
  },
  Blob: function () {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(appSrc, sandbox);

const GRTUI = sandbox.window.GRTUI;
let failed = 0;
function assert(cond, msg) {
  if (cond) { console.log('ok   ' + msg); }
  else { console.error('FAIL ' + msg); failed++; }
}
const wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

(async function () {
  assert(GRTUI && typeof GRTUI.addCandidates === 'function', 'GRTUI 已挂载，页面初始化成功');

  // 1. 首次输入去重库A
  els['dedup-paste'].value = '北京云澳瑞驰科技有限公司\n天津某测试公司';
  GRTUI.pasteDedupA();
  assert(/2 家（本机记忆）/.test(els['stat-a'].textContent), '去重库A已记忆');

  // 2. 一键获取候选：新公司带云端AI查验结果，应自动应用并显示可输出
  GRTUI.fetchCandidates();
  await wait(30);
  assert(els['cand-summary'].textContent.indexOf('候选共 2 家') !== -1, '候选池共2家');
  assert(els['cand-list'].innerHTML.indexOf('云端AI查验') !== -1, '云端AI查验结果自动应用');
  assert(els['cand-list'].innerHTML.indexOf('✔ 可输出') !== -1, '云端查验通过后直接可输出');

  // 3. 生成输出（无地址列）
  els['out-count'].value = '20';
  GRTUI.generate();
  const out = els['out-text'].value;
  assert(out.indexOf('公司名称\t匹配业务线\t电话\t姓名\t邮箱\t备注') !== -1, '输出表头无地址列');
  assert(out.indexOf('测试新公司科技有限公司') !== -1, '输出包含新公司');
  assert(out.indexOf('北京云澳瑞驰科技有限公司') === -1, '命中去重库A的公司未输出');
  assert(out.indexOf('第1次输出') !== -1, '输出时间标注正确（第1次）');
  assert(/1 家/.test(els['stat-b'].textContent), '去重库B已累积1家');

  // 4. 手动候选走自动初筛（无云端查验）：①④应未通过，且无③地址项
  els['cand-input'].value = '测试第二家公司有限公司\t组装、制造';
  GRTUI.addCandidates();
  const ids = els['cand-list'].innerHTML.match(/data-id="([^"]+)"/g).map(function (m) { return m.slice(9, -1); });
  const fresh2 = ids[ids.length - 1];
  GRTUI.verifyOne(fresh2);
  assert(els['cand-list'].innerHTML.indexOf('自动初筛') !== -1, '自动初筛摘要已显示');
  assert(els['cand-list'].innerHTML.indexOf('③') === -1, '校验项中已无③地址项');
  assert(els['cand-list'].innerHTML.indexOf('②现用全称✓') !== -1, '自动初筛确认②现用全称');
  assert(els['cand-list'].innerHTML.indexOf('⑤实体研产✓') !== -1, '自动初筛确认⑤实体研产');
  assert(els['cand-list'].innerHTML.indexOf('①工商状态✗') !== -1, '自动初筛未确认①工商状态');

  // 5. 只查验公司名字：命中A、命中B、未命中
  els['namecheck-input'].value = '北京云澳瑞驰科技有限公司\n测试新公司科技有限公司\n全新测试公司有限公司';
  GRTUI.checkNamesOnly();
  const nc = els['namecheck-result'].innerHTML;
  assert(nc.indexOf('命中A') !== -1, '只查名字：命中去重库A');
  assert(nc.indexOf('命中B') !== -1, '只查名字：命中去重库B');
  assert(nc.indexOf('未命中') !== -1, '只查名字：未命中');
  assert(els['namecheck-summary'].textContent.indexOf('共 3 家') !== -1, '只查名字：汇总正确');
  GRTUI.addNamecheckFresh();
  assert(els['cand-summary'].textContent.indexOf('候选共 4 家') !== -1, '未命中的公司已加入候选池');

  // 6. 曾用名重跑
  GRTUI.rerun(fresh2);
  assert(els['cand-list'].innerHTML.indexOf('已触发曾用名重跑') !== -1, '曾用名重跑标记出现');

  // 7. 一键导出初筛名单（Excel / 制表符文本）
  const backups = [];
  sandbox.document.createElement = function () {
    const el = makeEl('dyn');
    el.click = function () { backups.push(el); };
    return el;
  };
  GRTUI.exportCandidatesTsv();
  assert(backups.length === 1 && backups[0].download.indexOf('初筛名单') !== -1 && backups[0].download.endsWith('.txt'),
    '导出初筛名单(制表符)触发下载');
  GRTUI.exportCandidatesXlsx();
  assert(xlsxCalls.length === 1 && xlsxCalls[0].endsWith('.xlsx'), '导出初筛名单(Excel)调用 writeFile');
  GRTUI.exportNamecheckTsv();
  assert(backups.length === 2 && backups[1].download.indexOf('查重结果') !== -1, '只查名字结果可导出(制表符)');

  if (failed) {
    console.error('\n共 ' + failed + ' 项失败');
    process.exit(1);
  }
  console.log('\nDOM 冒烟测试全部通过');
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
