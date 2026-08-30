'use strict';

// 核心逻辑测试：node tests/test_core.js
const path = require('path');
const GRT = require(path.join(__dirname, '..', 'app.js'));

let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log('ok   ' + msg);
  } else {
    console.error('FAIL ' + msg + ' => got ' + a + ', expected ' + b);
    failed++;
  }
}

// ---------- 标准化 ----------
eq(GRT.norm('北京 某某（科技）有限公司'), '北京某某(科技)有限公司', 'norm: 去空格+全角括号转半角');
eq(GRT.norm('ＡＢＣ(中国)科技'), 'ABC(中国)科技', 'norm: 转大写');
eq(GRT.norm('  北京　某某（股份）　'), '北京某某(股份)', 'norm: 全角空格与首尾空格');
eq(GRT.norm('北京某某(科技)有限公司'), '北京某某(科技)有限公司', 'norm: 半角括号保持不变');

// ---------- 行解析 ----------
eq(GRT.parseCandidateLine('北京某某科技有限公司'), { name: '北京某某科技有限公司', address: '', scope: '', bizline: '', remark: '', product: '' }, 'parse: 单字段');
eq(GRT.parseCandidateLine('北京某某科技有限公司\t北京市海淀区'), { name: '北京某某科技有限公司', address: '北京市海淀区', scope: '', bizline: '', remark: '', product: '' }, 'parse: 名称+地址');
eq(GRT.parseCandidateLine('北京某某科技有限公司\t北京市海淀区\t生产、研发'), { name: '北京某某科技有限公司', address: '北京市海淀区', scope: '生产、研发', bizline: '', remark: '', product: '' }, 'parse: 名称+地址+经营范围');
eq(GRT.parseCandidateLine('北京某某科技有限公司\t服务器/信创整机\t\t\t\t备注内容\t北京市海淀区'), { name: '北京某某科技有限公司', bizline: '服务器/信创整机', remark: '备注内容', address: '北京市海淀区', scope: '', product: '' }, 'parse: 七字段历史输出格式');
eq(GRT.parseCandidateLine('  '), null, 'parse: 空行返回null');

// ---------- 去重映射 ----------
const dedupA = GRT.buildDedupMap(['北京 某某（科技）有限公司', '北京某某(科技)有限公司', '天津某某有限公司']);
eq(dedupA.size, 2, 'dedupMap: 标准化后去重');
eq(dedupA.has(GRT.norm('北京某某(科技)有限公司')), true, 'dedupMap: 命中');

// ---------- 输出计数（步骤9） ----------
eq(GRT.nextCounter({ date: '2026-08-30', n: 3 }, '2026-08-30'), { date: '2026-08-30', n: 4 }, 'counter: 同一天递增');
eq(GRT.nextCounter({ date: '2026-08-30', n: 3 }, '2026-08-31'), { date: '2026-08-31', n: 1 }, 'counter: 跨天重置');
eq(GRT.nextCounter({ date: '', n: 0 }, '2026-08-30'), { date: '2026-08-30', n: 1 }, 'counter: 首次输出');

// ---------- 备注生成（步骤6） ----------
const r1 = GRT.buildRemark('服务器/信创整机', '', '生产、研发、制造');
eq(/国产化光纤网卡/.test(r1) && /自研以太网控制器芯片/.test(r1), true, 'remark: 服务器含具体产品');
const r2 = GRT.buildRemark('数据中心', '', '');
eq(/光模块/.test(r2) && /内部互联/.test(r2), true, 'remark: 数据中心含光模块');
const r3 = GRT.buildRemark('网络安全', '', '');
eq(/Bypass网卡/.test(r3) && /非纯贸易商/.test(r3), true, 'remark: 网络安全含实体属性');
const r4 = GRT.buildRemark('工业通信', '', '');
eq(/工业通信组件/.test(r4), true, 'remark: 工业通信含组件');

// ---------- 五项校验与输出判定（步骤10） ----------
const good = {
  name: '北京某某科技有限公司', address: '北京市海淀区', bizline: '网络安全', remark: '备注',
  checks: { a: true, b: true, c: true, d: true, e: true }, dedupOk: true
};
eq(GRT.rowPass(good), true, 'pass: 全部通过');
eq(GRT.rowFailReasons(good).length, 0, 'pass: 无未通过原因');

const dup = Object.assign({}, good, { dedupOk: false, dedupNote: '命中去重库A：北京某某(科技)有限公司' });
eq(GRT.rowPass(dup), false, 'fail: 命中去重库不输出');
eq(GRT.rowFailReasons(dup).length, 1, 'fail: 仅报去重原因');

const badAddr = Object.assign({}, good, { address: '上海市浦东新区' });
eq(GRT.rowPass(badAddr), true, 'pass: 地址不在京津冀仍可输出（仅提示，人工复核）');
eq(GRT.rowFailReasons(badAddr).some(function (r) { return /京津冀/.test(r); }), true, 'fail: 地址提示包含京津冀关键词');

const noRemark = Object.assign({}, good, { remark: '' });
eq(GRT.rowPass(noRemark), false, 'fail: 备注为空不输出');

const noChecks = Object.assign({}, good, { checks: { a: true, b: true, c: true, d: true, e: false } });
eq(GRT.rowPass(noChecks), false, 'fail: 五项校验缺一不输出');

if (failed) {
  console.error('\n共 ' + failed + ' 项失败');
  process.exit(1);
}
console.log('\n全部测试通过');
