'use strict';

// 浏览器环境冒烟测试：node tests/test_dom_smoke.js
// 模拟 document/localStorage/fetch，跑通：
// 载入去重库A → 一键获取候选 → AI验证（五项全过）→ 输出 → B库累积 → 自动初筛 → 曾用名重跑。
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
  'ai-base', 'ai-key', 'ai-model'
].forEach(function (id) { els[id] = makeEl(id); });

const store = {};
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
  fetch: function (url) {
    if (String(url).indexOf('chat/completions') !== -1) {
      const verdict = {
        a: { pass: true, reason: '工商状态存续' },
        b: { pass: true, reason: '现用法定全称' },
        c: { pass: true, reason: '京津冀地址' },
        d: { pass: true, reason: '双源交叉验证' },
        e: { pass: true, reason: '实体研产属性' }
      };
      return Promise.resolve({
        ok: true,
        json: function () {
          return Promise.resolve({ choices: [{ message: { content: JSON.stringify(verdict) } }] });
        }
      });
    }
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
  assert(els['stat-a'].textContent.indexOf('未载入') !== -1, '初始状态：去重库A未载入');

  // 1. 首次输入去重库A（粘贴方式）
  els['dedup-paste'].value = '北京云澳瑞驰科技有限公司\n天津某测试公司';
  GRTUI.pasteDedupA();
  assert(/2 家（本机记忆）/.test(els['stat-a'].textContent), '去重库A已记忆');

  // 2. 手动录入命中去重库A的公司 → 标红
  els['cand-input'].value = '北京云澳瑞驰科技有限公司\t北京市海淀区';
  GRTUI.addCandidates();
  assert(els['cand-list'].innerHTML.indexOf('命中去重库A') !== -1, '手动录入命中去重库A自动标红');

  // 3. 一键获取候选（fetch 桩：1 家重复自动跳过 + 1 家新公司）
  GRTUI.fetchCandidates();
  await wait(30);
  assert(els['cand-summary'].textContent.indexOf('候选共 2 家') !== -1, '候选池共2家（重复自动跳过）');
  const ids = els['cand-list'].innerHTML.match(/data-id="([^"]+)"/g).map(function (m) { return m.slice(9, -1); });
  const fresh = ids[ids.length - 1];

  // 4. 配置 AI 接口并执行 AI 验证（五项全过）
  els['ai-base'].value = 'https://api.example.com/v1';
  els['ai-key'].value = 'sk-test';
  els['ai-model'].value = 'gpt-test';
  GRTUI.saveAISettings();
  GRTUI.verifyOne(fresh);
  await wait(30);
  assert(els['cand-list'].innerHTML.indexOf('AI验证') !== -1, 'AI 验证摘要已显示');
  assert(els['cand-list'].innerHTML.indexOf('重新验证') !== -1, '验证后按钮变为「重新验证」');
  assert(els['cand-list'].innerHTML.indexOf('✔ 可输出') !== -1, '五项通过后显示可输出');

  // 5. 生成输出
  els['out-count'].value = '20';
  GRTUI.generate();
  const out = els['out-text'].value;
  assert(out.indexOf('测试新公司科技有限公司') !== -1, '输出包含新公司');
  assert(out.indexOf('北京云澳瑞驰科技有限公司') === -1, '命中去重库A的公司未输出');
  assert(out.indexOf('第1次输出') !== -1, '输出时间标注正确（第1次）');
  assert(/1 家/.test(els['stat-b'].textContent), '去重库B已累积1家');

  // 6. 自动初筛路径（未配置 AI Key）：③⑤应通过、①应未通过
  els['cand-input'].value = '测试第二家公司有限公司\t天津市滨海新区\t组装、制造';
  GRTUI.addCandidates();
  const ids2 = els['cand-list'].innerHTML.match(/data-id="([^"]+)"/g).map(function (m) { return m.slice(9, -1); });
  const fresh2 = ids2[ids2.length - 1];
  els['ai-key'].value = '';
  GRTUI.saveAISettings();
  GRTUI.verifyOne(fresh2);
  assert(els['cand-list'].innerHTML.indexOf('自动初筛') !== -1, '自动初筛摘要已显示');
  assert(els['cand-list'].innerHTML.indexOf('①工商状态✗') !== -1, '自动初筛未确认①工商状态');
  assert(els['cand-list'].innerHTML.indexOf('③京津冀地址✓') !== -1, '自动初筛确认③京津冀地址');
  assert(els['cand-list'].innerHTML.indexOf('⑤实体研产✓') !== -1, '自动初筛确认⑤实体研产');

  // 7. 曾用名重跑：重置全部校验
  GRTUI.rerun(fresh2);
  assert(els['cand-list'].innerHTML.indexOf('已触发曾用名重跑') !== -1, '曾用名重跑标记出现');

  if (failed) {
    console.error('\n共 ' + failed + ' 项失败');
    process.exit(1);
  }
  console.log('\nDOM 冒烟测试全部通过');
})().catch(function (e) {
  console.error('测试异常：', e);
  process.exit(1);
});
