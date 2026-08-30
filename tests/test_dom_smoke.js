'use strict';

// 浏览器环境冒烟测试：node tests/test_dom_smoke.js
// 在沙箱中模拟 document/localStorage/fetch，跑通：
// 载入去重库A → 手动录入查重 → 一键获取候选 → 校验 → 生成输出 → B库累积 → 曾用名重跑。
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
  'out-count', 'out-text', 'dedup-paste', 'b-import-text'
].forEach(function (id) { els[id] = makeEl(id); });

const store = {};
const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
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
            { name: '北京云澳瑞驰科技有限公司', address_hint: '北京市海淀区', scope_hint: '生产、研发', bizline: '服务器/信创整机', source_url: 'https://example.com/1' },
            { name: '测试新公司科技有限公司', address_hint: '北京市朝阳区', scope_hint: '生产、研发、制造', bizline: '网络安全', source_url: 'https://example.com/2' }
          ]
        });
      }
    });
  },
  localStorage: {
    getItem: function (k) { return store[k] || null; },
    setItem: function (k, v) { store[k] = String(v); }
  },
  navigator: {},
  document: {
    getElementById: function (id) { return els[id] || null; },
    createElement: function () { return makeEl('dyn'); },
    body: { appendChild: function () {}, removeChild: function () {} }
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
  assert(els['stat-a'].textContent.indexOf('未载入') !== -1, '初始状态：去重库A未载入');

  // 1. 首次输入去重库A（粘贴方式）
  els['dedup-paste'].value = '北京云澳瑞驰科技有限公司\n天津某测试公司';
  GRTUI.pasteDedupA();
  assert(/2 家（本机记忆）/.test(els['stat-a'].textContent), '去重库A已记忆（' + els['stat-a'].textContent + '）');

  // 2. 手动录入命中去重库A的公司 → 标红
  els['cand-input'].value = '北京云澳瑞驰科技有限公司\t北京市海淀区';
  GRTUI.addCandidates();
  assert(els['cand-list'].innerHTML.indexOf('命中去重库A') !== -1, '手动录入命中去重库A自动标红');

  // 3. 一键获取候选（fetch 桩返回 2 家，其中 1 家命中A库）
  GRTUI.fetchCandidates();
  await wait(30);
  assert(els['cand-summary'].textContent.indexOf('候选共 2 家') !== -1, '候选池共2家（1手动+1新增，重复自动跳过）');
  assert(els['cand-list'].innerHTML.indexOf('测试新公司科技有限公司') !== -1, '自动候选已进入候选池');

  // 4. 对自动候选完成校验并生成输出
  const ids = els['cand-list'].innerHTML.match(/data-id="([^"]+)"/g).map(function (m) { return m.slice(9, -1); });
  const fresh = ids[ids.length - 1];
  ['a', 'b', 'c', 'd', 'e'].forEach(function (k) { GRTUI.toggleCheck(fresh, k, true); });
  GRTUI.editBiz(fresh, '网络安全');
  GRTUI.genRemark(fresh);
  assert(els['cand-list'].innerHTML.indexOf('✔ 可输出') !== -1, '五项校验完成后显示可输出');

  els['out-count'].value = '20';
  GRTUI.generate();
  const out = els['out-text'].value;
  assert(out.indexOf('公司名称\t匹配业务线\t电话\t姓名\t邮箱\t备注\t地址') !== -1, '输出包含表头且为制表符分隔');
  assert(out.indexOf('测试新公司科技有限公司') !== -1, '输出包含新公司');
  assert(out.indexOf('北京云澳瑞驰科技有限公司') === -1, '命中去重库A的公司未输出');
  assert(out.indexOf('输出时间：') !== -1 && out.indexOf('第1次输出') !== -1, '输出时间标注正确（第1次）');
  assert(/1 家/.test(els['stat-b'].textContent), '去重库B已累积1家');
  assert(els['hist-list'].innerHTML.indexOf('第1次输出') !== -1, '历史输出已归档');

  // 5. 第二次输出（新公司）→ 第2次
  els['cand-input'].value = '测试第二家公司有限公司\t天津市滨海新区\t组装、制造';
  GRTUI.addCandidates();
  const ids2 = els['cand-list'].innerHTML.match(/data-id="([^"]+)"/g).map(function (m) { return m.slice(9, -1); });
  const fresh2 = ids2[ids2.length - 1];
  ['a', 'b', 'c', 'd', 'e'].forEach(function (k) { GRTUI.toggleCheck(fresh2, k, true); });
  GRTUI.editBiz(fresh2, '工业通信');
  GRTUI.genRemark(fresh2);
  GRTUI.generate();
  assert(els['out-text'].value.indexOf('第2次输出') !== -1, '同一天第二次输出计数递增');

  // 6. 曾用名重跑
  GRTUI.rerun(fresh);
  assert(els['cand-list'].innerHTML.indexOf('已触发曾用名重跑') !== -1, '曾用名重跑标记出现');
  assert(els['cand-list'].innerHTML.indexOf('✔ 可输出') === -1, '重跑后校验被重置，不再可输出');

  // 7. 导出去重库A（验证下载触发）
  const backups = [];
  sandbox.document.createElement = function () {
    const el = makeEl('dyn');
    el.click = function () { backups.push(el); };
    return el;
  };
  GRTUI.exportDedupA();
  assert(backups.length === 1, '导出去重库A触发了下载');

  if (failed) {
    console.error('\n共 ' + failed + ' 项失败');
    process.exit(1);
  }
  console.log('\nDOM 冒烟测试全部通过');
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
