'use strict';

/* =====================================================================
   光润通 · 目标客户查找工作流自动化工具
   依据：《工作流（含用户画像及查找方式）— 修订版 V3.1》
   实现：前置查重 + 五项校验 + 业务线分类 + 备注生成 + 标准输出
   ===================================================================== */

/* ---------- 去重库 A（用户首次输入，保存在本机浏览器，可导出分享） ----------
   不再内置客户名单：公开部署也不会泄露任何客户数据。
   载入方式：上传 Excel/JSON/TXT，或粘贴文本；本机自动记忆。 */
/*__DEDUP_A_START__*/
const DEDUP_A_RAW = [];
/*__DEDUP_A_END__*/

/* ---------- 常量 ---------- */
const BIZLINES = ['服务器/信创整机', '数据中心', '网络安全', '工业通信'];
const PRODUCTS = [
  '国产化光纤网卡', '自研以太网控制器芯片', '光模块', 'Bypass网卡',
  '单向传输网卡', '加密网卡', '工业通信组件'
];
const DEFAULT_PRODUCT = {
  '服务器/信创整机': '国产化光纤网卡',
  '数据中心': '光模块',
  '网络安全': 'Bypass网卡',
  '工业通信': '工业通信组件'
};
const STORAGE_KEY = 'grt_workflow_v1';

/* ---------- 纯函数（可在 Node 中测试） ---------- */
const GRT = {};

function pad2(x) { return String(x).padStart(2, '0'); }

// 标准化规则：去空格、转大写、全角括号转半角、中文括号统一为英文括号
GRT.norm = function (s) {
  return String(s == null ? '' : s)
    .replace(/[\s\u3000\u200b\ufeff]+/g, '')
    .replace(/[\uFF01-\uFF5E]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    })
    .toUpperCase()
    .replace(/[（(]/g, '(')
    .replace(/[）)]/g, ')');
};

GRT.todayKey = function () {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
};

GRT.dateLabel = function (d) {
  d = d || new Date();
  return d.getFullYear() + '年' + pad2(d.getMonth() + 1) + '月' + pad2(d.getDate()) + '日';
};

// 候选行解析：支持 1 字段（名称）、2 字段（名称+地址）、
// 3 字段（名称+地址+经营范围）、7 字段（历史输出格式：名称 业务线 电话 姓名 邮箱 备注 地址）
GRT.parseCandidateLine = function (line) {
  const parts = String(line == null ? '' : line).split('\t').map(function (s) { return s.trim(); });
  if (!parts[0]) return null;
  if (parts.length >= 7) {
    return { name: parts[0], bizline: parts[1], remark: parts[5], address: parts[6], scope: '', product: '' };
  }
  if (parts.length === 3) {
    return { name: parts[0], address: parts[1], scope: parts[2], bizline: '', remark: '', product: '' };
  }
  if (parts.length === 2) {
    return { name: parts[0], address: parts[1], scope: '', bizline: '', remark: '', product: '' };
  }
  return { name: parts[0], address: '', scope: '', bizline: '', remark: '', product: '' };
};

GRT.buildDedupMap = function (names) {
  const m = new Map();
  for (const n of names || []) {
    const k = GRT.norm(n);
    if (k && !m.has(k)) m.set(k, String(n).trim());
  }
  return m;
};

// 批次计数：日期变化则 N 从 1 重新累加
GRT.nextCounter = function (counter, today) {
  if (counter && counter.date === today) return { date: today, n: (counter.n || 0) + 1 };
  return { date: today, n: 1 };
};

GRT.buildRemark = function (bizline, product, scope) {
  const scopeText = scope ? String(scope).trim().slice(0, 40) : '';
  switch (bizline) {
    case '服务器/信创整机':
      return '该公司为服务器/信创整机硬件研发生产厂商' + (scopeText ? '（' + scopeText + '）' : '') +
        '，需采购国产化光纤网卡及自研以太网控制器芯片用于整机板载集成。';
    case '数据中心':
      return '该公司运营' + (scopeText || '数据中心') +
        '，自有机房/算力网络建设需求，需大量光模块及万兆以太网卡用于内部互联。';
    case '网络安全':
      return '该公司为网络安全硬件研发制造商（非纯贸易商）' + (scopeText ? '（' + scopeText + '）' : '') +
        '，需集成Bypass网卡/加密网卡/单向传输网卡用于自身安全设备。';
    case '工业通信':
      return '该公司为工业通信设备硬件研发制造商（非纯贸易商）' + (scopeText ? '（' + scopeText + '）' : '') +
        '，需工业通信组件用于自身嵌入式板卡/网关产品。';
    default:
      return '该公司' + (scopeText ? '（' + scopeText + '）' : '') +
        '，需采购/集成' + (product || '光润通系列产品') + '。';
  }
};

GRT.allChecks = function (c) {
  return !!(c && c.checks && c.checks.a && c.checks.b && c.checks.c && c.checks.d && c.checks.e);
};

// 一条候选是否可输出（步骤10 复核逻辑）
GRT.rowPass = function (c) {
  return !!(c && c.name && GRT.norm(c.name) && c.dedupOk && GRT.allChecks(c) &&
    c.address && c.bizline && c.remark);
};

// 未通过原因清单（供界面显示）
GRT.rowFailReasons = function (c) {
  const reasons = [];
  if (!c || !c.name || !GRT.norm(c.name)) reasons.push('未填写公司名称');
  else if (!c.dedupOk) reasons.push(c.dedupNote || '命中去重库');
  if (!c.checks.a) reasons.push('① 工商状态（存续/在业）未确认');
  if (!c.checks.b) reasons.push('② 现用法定全称未确认');
  if (!c.checks.c) reasons.push('③ 注册地址京津冀未确认');
  if (!c.checks.d) reasons.push('④ 双源交叉验证未确认');
  if (!c.checks.e) reasons.push('⑤ 实体研发/生产属性未确认');
  if (!c.address) reasons.push('未填写注册地址');
  else if (!/北京|天津|河北/.test(c.address)) reasons.push('地址不含京津冀关键词，请复核');
  if (!c.bizline) reasons.push('未选择匹配业务线');
  if (!c.remark) reasons.push('备注为空');
  return reasons;
};

/* ---------- 状态与存储 ---------- */
function defaultState() {
  return {
    candidates: [],
    dedupA: [],                       // 用户载入的去重库A（首次输入，自动记忆）
    dedupB: {},
    counter: { date: '', n: 0 },
    history: [],
    settings: { aiBaseUrl: '', aiKey: '', aiModel: '' }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const st = JSON.parse(raw);
      return Object.assign(defaultState(), st);
    }
  } catch (e) {
    console.warn('读取本地存储失败', e);
  }
  return defaultState();
}

let state = null;
let dedupA = null; // Map(标准化名称 -> 原名称)

function rebuildDedupA() {
  dedupA = GRT.buildDedupMap(state.dedupA);
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('保存本地存储失败', e);
    showNote('警告：数据未能保存到浏览器本地存储（如隐私模式），本次操作仅在当前页面有效。', 'err');
  }
}

/* ---------- 查重刷新（前置查重：优先级高于其他一切） ---------- */
function refreshDedup() {
  if (!state) return;
  for (const c of state.candidates) {
    const k = GRT.norm(c.name);
    if (!k) { c.dedupOk = false; c.dedupNote = '未填写名称'; continue; }
    const batchDup = state.candidates.find(function (o) {
      return o.id !== c.id && o.name && GRT.norm(o.name) === k;
    });
    if (batchDup) { c.dedupOk = false; c.dedupNote = '本批重复：' + batchDup.name; continue; }
    if (dedupA.has(k)) { c.dedupOk = false; c.dedupNote = '命中去重库A：' + dedupA.get(k); continue; }
    if (state.dedupB[k]) { c.dedupOk = false; c.dedupNote = '命中去重库B：' + state.dedupB[k]; continue; }
    c.dedupOk = true; c.dedupNote = '';
  }
}

/* ---------- 渲染辅助 ---------- */
function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showNote(msg, type) {
  const el = $('note');
  if (!el) return;
  el.textContent = msg;
  el.className = 'note ' + (type === 'err' ? 'note-err' : 'note-ok');
  el.style.display = 'block';
  clearTimeout(showNote._t);
  showNote._t = setTimeout(function () { el.style.display = 'none'; }, 6000);
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- 渲染：状态卡片 ---------- */
function renderStatus() {
  $('stat-a').textContent = state.dedupA.length ?
    state.dedupA.length.toLocaleString() + ' 家（本机记忆）' :
    '未载入（首次使用请上传）';
  $('stat-b').textContent = Object.keys(state.dedupB).length.toLocaleString() + ' 家';
  $('stat-total').textContent = (dedupA.size + Object.keys(state.dedupB).length).toLocaleString() + ' 家';
  const today = GRT.todayKey();
  $('stat-counter').textContent = (state.counter.date === today) ?
    '今日已输出：第 ' + state.counter.n + ' 次' : '今日尚未输出';
}

/* ---------- 渲染：候选池 ---------- */
function candBadge(c) {
  if (!c.name || !GRT.norm(c.name)) return { text: '待填写', cls: 'badge-gray' };
  if (!c.dedupOk) return { text: c.dedupNote, cls: 'badge-red' };
  return GRT.allChecks(c) ? { text: '✔ 可输出', cls: 'badge-green' } : { text: '待校验', cls: 'badge-amber' };
}

// 只更新单张卡片的徽章与未通过原因，不重绘整个列表（避免输入框被替换、无法连续输入）
function updateCardUI(id) {
  const card = document.querySelector('.card[data-id="' + id + '"]');
  if (!card) return;
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  const badge = candBadge(c);
  const badgeEl = card.querySelector('.badge');
  if (badgeEl) {
    badgeEl.className = 'badge ' + badge.cls;
    badgeEl.textContent = badge.text;
  }
  const reasons = GRT.rowFailReasons(c);
  const failEl = card.querySelector('.fail');
  if (reasons.length) {
    const html = '未通过：' + reasons.map(esc).join('；');
    if (failEl) failEl.innerHTML = html;
    else {
      const div = document.createElement('div');
      div.className = 'row fail';
      div.innerHTML = html;
      card.appendChild(div);
    }
  } else if (failEl) {
    failEl.remove();
  }
}

function candCard(c) {
  const badge = candBadge(c);
  const reasons = GRT.rowFailReasons(c);
  const checks = c.checks || {};
  return '<div class="card" data-id="' + c.id + '">' +
    '<div class="row r1">' +
      '<span class="badge ' + badge.cls + '">' + esc(badge.text) + '</span>' +
      '<input class="in-name" value="' + esc(c.name) + '" oninput="GRTUI.editName(\'' + c.id + '\', this.value)" placeholder="公司现用法定全称（必填）" />' +
      '<button class="btn small ai" onclick="GRTUI.verifyOne(\'' + c.id + '\')">' + (c.verify ? '重新验证' : 'AI 验证') + '</button>' +
      '<button class="btn small" onclick="GRTUI.rerun(\'' + c.id + '\')" title="遇到曾用名：输入现用全称后强制重跑全部校验">曾用名→重跑</button>' +
      '<button class="btn small" onclick="GRTUI.search(\'' + c.id + '\')">百度核验</button>' +
      '<button class="btn small" onclick="GRTUI.searchQcc(\'' + c.id + '\')">企查查</button>' +
      '<button class="btn small" onclick="GRTUI.searchTyc(\'' + c.id + '\')">天眼查</button>' +
      '<button class="btn small danger" onclick="GRTUI.del(\'' + c.id + '\')">删除</button>' +
    '</div>' +
    '<div class="row r2">' +
      '<input class="in-addr" value="' + esc(c.address) + '" oninput="GRTUI.editAddr(\'' + c.id + '\', this.value)" placeholder="注册地址（须京津冀，如：北京市海淀区…）" />' +
      '<input class="in-scope" value="' + esc(c.scope) + '" oninput="GRTUI.editScope(\'' + c.id + '\', this.value)" placeholder="经营范围 / 实体依据（可选，用于生成备注）" />' +
    '</div>' +
    '<div class="row r3">' +
      '<span class="check-label">五项校验：</span>' +
      '<label><input type="checkbox" ' + (checks.a ? 'checked' : '') + ' onchange="GRTUI.toggleCheck(\'' + c.id + '\',\'a\',this.checked)" />① 存续/在业</label>' +
      '<label><input type="checkbox" ' + (checks.b ? 'checked' : '') + ' onchange="GRTUI.toggleCheck(\'' + c.id + '\',\'b\',this.checked)" />② 现用法定全称</label>' +
      '<label><input type="checkbox" ' + (checks.c ? 'checked' : '') + ' onchange="GRTUI.toggleCheck(\'' + c.id + '\',\'c\',this.checked)" />③ 京津冀地址</label>' +
      '<label><input type="checkbox" ' + (checks.d ? 'checked' : '') + ' onchange="GRTUI.toggleCheck(\'' + c.id + '\',\'d\',this.checked)" />④ 双源交叉验证</label>' +
      '<label><input type="checkbox" ' + (checks.e ? 'checked' : '') + ' onchange="GRTUI.toggleCheck(\'' + c.id + '\',\'e\',this.checked)" />⑤ 实体研产属性</label>' +
      (c.rerun ? '<span class="tag tag-rerun">已触发曾用名重跑：须重新完成全部校验</span>' : '') +
    '</div>' +
    '<div class="row r4">' +
      '<select class="in-biz" onchange="GRTUI.editBiz(\'' + c.id + '\', this.value)">' +
        '<option value="">匹配业务线</option>' +
        BIZLINES.map(function (b) { return '<option' + (c.bizline === b ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('') +
      '</select>' +
      '<select class="in-prod" onchange="GRTUI.editProd(\'' + c.id + '\', this.value)">' +
        '<option value="">产品类型</option>' +
        PRODUCTS.map(function (p) { return '<option' + (c.product === p ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn small" onclick="GRTUI.genRemark(\'' + c.id + '\')">生成备注</button>' +
      '<span class="src-label">来源记录：</span>' +
      '<input class="in-src" value="' + esc(c.sources) + '" oninput="GRTUI.editSrc(\'' + c.id + '\', this.value)" placeholder="如：企查查+官网（可选）" />' +
    '</div>' +
    '<div class="row r5">' +
      '<textarea class="in-remark" rows="2" oninput="GRTUI.editRemark(\'' + c.id + '\', this.value)" placeholder="备注：实体属性描述 + 具体产品 + 匹配逻辑（必填）">' + esc(c.remark) + '</textarea>' +
    '</div>' +
    (c.verify ? '<div class="row verify">' + esc(c.verify.summary) + '</div>' : '') +
    (reasons.length ?
      '<div class="row fail">未通过：' + reasons.map(esc).join('；') + '</div>' : '') +
  '</div>';
}

function renderCandidates() {
  const list = $('cand-list');
  if (!state.candidates.length) {
    list.innerHTML = '<div class="empty">暂无候选公司。请在下方录入区粘贴候选名单，或先用右侧关键词去百度/企查查/天眼查查找。</div>';
  } else {
    list.innerHTML = state.candidates.map(candCard).join('');
  }
  const passed = state.candidates.filter(function (c) { return GRT.rowPass(c); }).length;
  const dupCount = state.candidates.filter(function (c) { return c.dedupOk === false; }).length;
  $('cand-summary').textContent = '候选共 ' + state.candidates.length + ' 家；通过全部校验可输出 ' + passed + ' 家；未通过（含命中去重库）' + dupCount + ' 家。';
}

/* ---------- 渲染：历史输出 ---------- */
function renderHistory() {
  const list = $('hist-list');
  if (!state.history.length) {
    list.innerHTML = '<div class="empty">暂无历史输出。</div>';
    return;
  }
  list.innerHTML = state.history.map(function (h, i) {
    return '<div class="hist-item">' +
      '<span class="hist-label">' + esc(h.label) + ' 第' + h.n + '次输出 · 共' + h.count + '家</span>' +
      '<button class="btn small" onclick="GRTUI.viewHist(' + i + ')">查看</button>' +
      '<button class="btn small" onclick="GRTUI.copyHist(' + i + ')">复制</button>' +
      '<button class="btn small danger" onclick="GRTUI.delHist(' + i + ')">删除</button>' +
    '</div>';
  }).join('');
}

function renderAll() {
  renderStatus();
  renderCandidates();
  renderHistory();
}

/* ---------- 界面操作 ---------- */
const GRTUI = {};

GRTUI.addCandidates = function () {
  const ta = $('cand-input');
  const text = ta.value;
  if (!text.trim()) { showNote('请先粘贴候选公司（每行一家）。', 'err'); return; }
  const lines = text.split(/\r?\n/);
  let added = 0;
  let skipped = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const p = GRT.parseCandidateLine(t);
    if (!p) { skipped++; continue; }
    state.candidates.push({
      id: genId(),
      name: p.name,
      address: p.address,
      scope: p.scope,
      bizline: p.bizline || '',
      product: p.product || '',
      remark: p.remark || '',
      sources: '',
      checks: { a: false, b: false, c: false, d: false, e: false },
      rerun: false
    });
    added++;
  }
  ta.value = '';
  refreshDedup();
  saveState();
  renderAll();
  showNote('已添加 ' + added + ' 家候选' + (skipped ? '，跳过空行/格式错误 ' + skipped + ' 行' : '') + '。命中去重库的条目已自动标红，不会进入输出。', 'ok');
};

GRTUI.editName = function (id, v) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.name = v;
  refreshDedup();
  state.candidates.forEach(function (x) { updateCardUI(x.id); });
  saveState();
};

GRTUI.editAddr = function (id, v) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.address = v;
  updateCardUI(id);
  saveState();
};

GRTUI.editScope = function (id, v) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.scope = v;
  saveState();
};

GRTUI.editBiz = function (id, v) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.bizline = v;
  updateCardUI(id);
  saveState();
};

GRTUI.editProd = function (id, v) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.product = v;
  saveState();
};

GRTUI.editRemark = function (id, v) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.remark = v;
  updateCardUI(id);
  saveState();
};

GRTUI.editSrc = function (id, v) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.sources = v;
  saveState();
};

GRTUI.toggleCheck = function (id, key, checked) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  c.checks[key] = checked;
  updateCardUI(id);
  saveState();
};

GRTUI.del = function (id) {
  state.candidates = state.candidates.filter(function (x) { return x.id !== id; });
  refreshDedup();
  renderAll();
  saveState();
};

// 曾用名强制重跑：输入现用法定全称后，重置全部校验，从头执行步骤3
GRTUI.rerun = function (id) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  const newName = prompt('检测到“曾用名”。请输入该公司现用法定全称（将重置全部校验并重新执行前置查重）：', c.name);
  if (newName == null) return;
  const n = newName.trim();
  if (!n) { showNote('未输入现用全称，操作已取消。', 'err'); return; }
  c.name = n;
  c.checks = { a: false, b: false, c: false, d: false, e: false };
  c.rerun = true;
  refreshDedup();
  renderAll();
  saveState();
  showNote('已触发曾用名强制重跑：请以现用全称重新完成前置查重与五项校验。', 'ok');
};

GRTUI.genRemark = function (id) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  if (!c.bizline) { showNote('请先选择匹配业务线，再生成备注。', 'err'); return; }
  c.remark = GRT.buildRemark(c.bizline, c.product, c.scope);
  renderCandidates();
  saveState();
};

function openUrl(url) { window.open(url, '_blank'); }

GRTUI.search = function (id) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c || !c.name) return;
  openUrl('https://www.baidu.com/s?wd=' + encodeURIComponent(c.name + ' 公司'));
};

GRTUI.searchQcc = function (id) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c || !c.name) return;
  openUrl('https://www.qcc.com/web/search?key=' + encodeURIComponent(c.name));
};

GRTUI.searchTyc = function (id) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c || !c.name) return;
  openUrl('https://www.tianyancha.com/search?key=' + encodeURIComponent(c.name));
};

GRTUI.baiduKw = function (q) {
  openUrl('https://www.baidu.com/s?wd=' + encodeURIComponent(q));
};

/* ---------- 输出 ---------- */
GRTUI.generate = function () {
  refreshDedup();
  const passed = state.candidates.filter(function (c) { return GRT.rowPass(c); });
  if (!passed.length) {
    showNote('没有可输出的候选：请至少让一家公司通过全部校验（见各卡片红色提示）。', 'err');
    renderCandidates();
    return;
  }
  const countMode = $('out-count').value;
  let rows = passed;
  if (countMode !== 'all') rows = passed.slice(0, parseInt(countMode, 10));

  const lines = rows.map(function (r) {
    return [r.name.trim(), r.bizline, '', '', '', r.remark.trim().replace(/\r?\n/g, ' '), r.address.trim()].join('\t');
  });
  const counter = GRT.nextCounter(state.counter, GRT.todayKey());
  const timeLine = '输出时间：' + GRT.dateLabel() + ' 第' + counter.n + '次输出';
  const text = '公司名称\t匹配业务线\t电话\t姓名\t邮箱\t备注\t地址\n' + lines.join('\n') + '\n' + timeLine;

  $('out-text').value = text;
  rows.forEach(function (r) {
    const k = GRT.norm(r.name);
    if (k) state.dedupB[k] = r.name.trim();
  });
  state.counter = counter;
  state.history.unshift({
    at: Date.now(),
    label: GRT.dateLabel(),
    n: counter.n,
    count: rows.length,
    text: text
  });
  if (state.history.length > 100) state.history.length = 100;
  saveState();
  renderAll();
  showNote('已生成：共 ' + rows.length + ' 家（第 ' + counter.n + ' 次输出），公司名称已自动加入去重库B，后续批次自动排重。', 'ok');
  $('out-text').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

GRTUI.copyOutput = function () {
  const t = $('out-text').value;
  if (!t) { showNote('还没有可复制的输出。', 'err'); return; }
  copyText(t, '输出已复制到剪贴板');
};

GRTUI.downloadOutput = function () {
  const t = $('out-text').value;
  if (!t) { showNote('还没有可下载的输出。', 'err'); return; }
  const d = new Date();
  const fname = '光润通输出_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    '_第' + (state.counter.n || 0) + '次.txt';
  download(fname, '\ufeff' + t, 'text/plain;charset=utf-8');
};

/* ---------- 历史 ---------- */
GRTUI.viewHist = function (i) {
  const h = state.history[i];
  if (!h) return;
  $('out-text').value = h.text;
  $('out-text').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

GRTUI.copyHist = function (i) {
  const h = state.history[i];
  if (!h) return;
  copyText(h.text, '已复制历史输出（第' + h.n + '次）');
};

GRTUI.delHist = function (i) {
  if (!confirm('确定删除该条历史输出？去重库B中已累积的公司名不受影响。')) return;
  state.history.splice(i, 1);
  saveState();
  renderHistory();
};

/* ---------- 去重库B 与备份 ---------- */
GRTUI.importBText = function () {
  const ta = $('b-import-text');
  const text = ta.value;
  if (!text.trim()) { showNote('请粘贴去重库B内容（每行一个公司名）。', 'err'); return; }
  let added = 0;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const k = GRT.norm(t);
    if (k && !state.dedupB[k]) { state.dedupB[k] = t; added++; }
  }
  ta.value = '';
  saveState();
  renderStatus();
  showNote('已并入去重库B：新增 ' + added + ' 家。', 'ok');
};

/* ---------- 去重库 A：首次输入、自动记忆、导出 ---------- */
function parseNamesText(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.split(/[\t,，;；]/)[0].replace(/^["']|["']$/g, '').trim();
    if (t) out.push(t);
  }
  return out;
}

function parseDedupJson(text) {
  const data = JSON.parse(text);
  if (Array.isArray(data)) {
    return data.map(function (n) { return String(n).trim(); }).filter(Boolean);
  }
  if (data && Array.isArray(data.names)) {
    return data.names.map(function (n) { return String(n).trim(); }).filter(Boolean);
  }
  throw new Error('JSON 格式须为名称数组或 {"names":[...]}');
}

function addDedupNames(names) {
  let added = 0;
  let skipped = 0;
  const have = new Set(state.dedupA.map(GRT.norm));
  for (const n of names || []) {
    const t = String(n).trim();
    if (!t) continue;
    const k = GRT.norm(t);
    if (!k || have.has(k)) { skipped++; continue; }
    have.add(k);
    state.dedupA.push(t);
    added++;
  }
  if (added) {
    rebuildDedupA();
    saveState();
    renderAll();
  }
  return { added: added, skipped: skipped };
}

function ensureXlsx(cb) {
  if (typeof XLSX !== 'undefined') { cb(); return; }
  const s = document.createElement('script');
  s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
  s.onload = cb;
  s.onerror = function () {
    showNote('Excel 解析组件加载失败（需联网）。请改用 JSON 或粘贴文本载入去重库A。', 'err');
  };
  document.head.appendChild(s);
}

GRTUI.loadDedupFile = function (input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const name = (file.name || '').toLowerCase();
  const finish = function (names) {
    const r = addDedupNames(names);
    showNote('去重库A已载入：新增 ' + r.added + ' 家，跳过重复/无效 ' + r.skipped + ' 条。', 'ok');
    input.value = '';
  };
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const reader = new FileReader();
    reader.onload = function () {
      const buf = reader.result;
      ensureXlsx(function () {
        try {
          const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
          const names = rows.map(function (r) { return r && r[0] ? String(r[0]).trim() : ''; }).filter(Boolean);
          finish(names);
        } catch (e) {
          showNote('Excel 解析失败：' + e.message, 'err');
          input.value = '';
        }
      });
    };
    reader.readAsArrayBuffer(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const text = String(reader.result || '');
      const names = name.endsWith('.json') ? parseDedupJson(text) : parseNamesText(text);
      finish(names);
    } catch (e) {
      showNote('文件解析失败：' + e.message, 'err');
      input.value = '';
    }
  };
  reader.readAsText(file, 'utf-8');
};

GRTUI.pasteDedupA = function () {
  const ta = $('dedup-paste');
  const text = ta.value;
  if (!text.trim()) { showNote('请先粘贴公司名称（每行一个）。', 'err'); return; }
  const r = addDedupNames(parseNamesText(text));
  ta.value = '';
  showNote('去重库A已并入：新增 ' + r.added + ' 家，跳过重复 ' + r.skipped + ' 条。', 'ok');
};

GRTUI.exportDedupA = function () {
  if (!state.dedupA.length) { showNote('去重库A为空，无需导出。', 'err'); return; }
  const d = new Date();
  download('去重库A_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.json',
    JSON.stringify({ app: 'grt-dedup-a', exportedAt: new Date().toISOString(), names: state.dedupA }, null, 1),
    'application/json');
};

GRTUI.clearDedupA = function () {
  const n = state.dedupA.length;
  if (!n) { showNote('去重库A为空。', 'err'); return; }
  if (!confirm('确定清空去重库A（' + n + ' 家）？建议先「导出去重库A」备份。')) return;
  state.dedupA = [];
  rebuildDedupA();
  refreshDedup();
  saveState();
  renderAll();
  showNote('去重库A已清空。', 'ok');
};

/* ---------- 自动查找：拉取候选池 ---------- */
function importCandidates(list) {
  const have = new Set(state.candidates.map(function (c) { return GRT.norm(c.name); }));
  let added = 0;
  for (const item of list || []) {
    const name = String(item.name || '').trim();
    if (!name) continue;
    const k = GRT.norm(name);
    if (have.has(k)) continue;
    have.add(k);
    state.candidates.push({
      id: genId(),
      name: name,
      address: item.address_hint || '',
      scope: item.scope_hint || '',
      bizline: item.bizline || '',
      product: '',
      remark: item.bizline ? GRT.buildRemark(item.bizline, '', item.scope_hint || '') : '',
      sources: item.source_url || '',
      checks: { a: false, b: false, c: false, d: false, e: false },
      rerun: false
    });
    added++;
  }
  if (added) {
    refreshDedup();
    saveState();
    renderAll();
  }
  return added;
}

GRTUI.fetchCandidates = function () {
  const btn = $('btn-fetch');
  if (btn) { btn.disabled = true; btn.textContent = '获取中…'; }
  const applyData = function (data) {
    const list = data.candidates || [];
    const added = importCandidates(list);
    showNote('已获取候选池：共 ' + list.length + ' 条，新增 ' + added +
      ' 家（其余为重复/已存在）。命中去重库的自动标红，完成校验后即可输出。', 'ok');
  };
  // 在线版：直接 fetch candidates.json；本地(file://)读取失败时，
  // 回退到 <script> 加载同目录 candidates.js（本地版也能一键获取）。
  const loadFromScript = function () {
    return new Promise(function (resolve, reject) {
      window.GRT_CANDIDATES = null;
      const s = document.createElement('script');
      s.src = 'candidates.js';
      s.onload = function () {
        const data = window.GRT_CANDIDATES;
        s.remove();
        if (data && Array.isArray(data.candidates)) resolve(data);
        else reject(new Error('candidates.js 内容无效'));
      };
      s.onerror = function () {
        s.remove();
        reject(new Error('candidates.js 加载失败'));
      };
      document.head.appendChild(s);
    });
  };
  // 本地(file://)无法 fetch，直接走脚本加载，避免无谓的控制台报错
  const isFile = window.location && window.location.protocol === 'file:';
  const fetchPromise = isFile ?
    Promise.reject(new Error('file://')) :
    fetch('candidates.json', { cache: 'no-store' })
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      });
  fetchPromise
    .then(applyData)
    .catch(function () {
      return loadFromScript().then(applyData);
    })
    .catch(function (e) {
      showNote('获取候选失败：' + e.message + '。请确认 index.html、app.js、candidates.js 在同一文件夹；仍不行可用「导入候选JSON」手动选择。', 'err');
    })
    .finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = '一键获取最新候选'; }
    });
};

GRTUI.importCandidatesFile = function (input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const data = JSON.parse(String(reader.result));
      const list = Array.isArray(data) ? data : (data.candidates || []);
      const added = importCandidates(list);
      showNote('候选导入成功：新增 ' + added + ' 家。', 'ok');
    } catch (e) {
      showNote('候选文件解析失败：' + e.message, 'err');
    }
    input.value = '';
  };
  reader.readAsText(file, 'utf-8');
};

GRTUI.clearCandidates = function () {
  if (!state.candidates.length) { showNote('候选池已为空。', 'err'); return; }
  if (!confirm('确定清空候选池？已输出的历史与去重库不受影响。')) return;
  state.candidates = [];
  refreshDedup();
  saveState();
  renderAll();
  showNote('候选池已清空。', 'ok');
};

/* ---------- 五项校验：AI 验证 / 自动初筛 ---------- */
function autoVerify(c) {
  // 基于现有证据的内置初筛：有证据的项自动勾选，无法确认的项明确标注原因
  const v = {};
  const blob = (c.name || '') + ' ' + (c.scope || '') + ' ' + (c.address || '') + ' ' + (c.sources || '');
  v.b = /(股份有限公司|有限责任公司|有限公司|集团)$/.test(c.name || '')
    ? { pass: true, reason: '名称含法定后缀' }
    : { pass: false, reason: '名称疑似不完整，需核实现用法定全称' };
  v.c = /北京|天津|河北/.test((c.address || '') + ' ' + (c.scope || ''))
    ? { pass: true, reason: '含京津冀地址信息' }
    : { pass: false, reason: '缺少京津冀地址证据' };
  const domains = new Set();
  String(c.sources || '').split(/[\s,，;；]+/).forEach(function (u) {
    try { domains.add(new URL(u).hostname.replace(/^www\./, '')); } catch (e) { /* 忽略 */ }
  });
  v.d = domains.size >= 2
    ? { pass: true, reason: '双源：' + Array.from(domains).join('、') }
    : { pass: false, reason: domains.size ? '仅单一来源，需补第二个独立来源' : '无来源记录' };
  v.e = /生产|制造|组装|研发|研制|代工|产线|硬件|设备|厂商|实业/.test(blob)
    ? { pass: true, reason: '具备实体研产特征' }
    : { pass: false, reason: '未见实体研产特征' };
  v.a = { pass: false, reason: '存续状态需工商数据源或 AI 接口确认' };
  return v;
}

function applyVerdict(c, v, method) {
  const labels = { a: '①工商状态', b: '②现用全称', c: '③京津冀地址', d: '④双源核验', e: '⑤实体研产' };
  const verdict = {};
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    if (!v[k] || typeof v[k].pass !== 'boolean') v[k] = { pass: false, reason: '未给出判断' };
    verdict[k] = v[k];
  }
  c.checks = {
    a: !!verdict.a.pass,
    b: !!verdict.b.pass,
    c: !!verdict.c.pass,
    d: !!verdict.d.pass,
    e: !!verdict.e.pass
  };
  const parts = [];
  for (const k of ['a', 'b', 'c', 'd', 'e']) {
    parts.push(labels[k] + (verdict[k].pass ? '✓' : '✗'));
  }
  c.verify = {
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
    method: method,
    verdict: verdict
  };
  // 摘要：方法 + 时间 + 各项结果；附带首个未通过原因
  const failReason = Object.keys(verdict).filter(function (k) { return !verdict[k].pass; })
    .map(function (k) { return labels[k] + '：' + verdict[k].reason; }).join('；');
  c.verify.summary = (method === 'ai' ? 'AI验证' : '自动初筛') + ' ' + c.verify.time + ' · ' +
    parts.join(' ') + (failReason ? ' · ' + failReason : '');
}

function aiVerify(c) {
  const st = state.settings || {};
  const info = {
    公司名称: c.name,
    地址线索: c.address || c.scope || '',
    经营范围线索: c.scope || '',
    来源: c.sources || ''
  };
  return fetch(String(st.aiBaseUrl || '').replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + st.aiKey },
    body: JSON.stringify({
      model: st.aiModel || 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: '你是企业情报核验助手。根据给定线索，对以下五项逐一判断并只输出JSON对象：' +
            '{"a":{"pass":布尔,"reason":"当前工商存续/在业状态判断"},"b":{"pass":布尔,"reason":"名称是否为现用法定全称"},"c":{"pass":布尔,"reason":"注册地址是否京津冀"},"d":{"pass":布尔,"reason":"是否至少两个独立来源交叉验证"},"e":{"pass":布尔,"reason":"是否具备硬件研发/生产/OEM实体属性"}}。' +
            '无法确认的项 pass 填 false 并在 reason 说明缺什么证据。'
        },
        { role: 'user', content: JSON.stringify(info) }
      ]
    })
  }).then(function (resp) {
    if (!resp.ok) {
      return resp.text().then(function (t) { throw new Error('HTTP ' + resp.status + ' ' + String(t).slice(0, 160)); });
    }
    return resp.json();
  }).then(function (data) {
    const content = data.choices && data.choices[0] && data.choices[0].message &&
      data.choices[0].message.content || '';
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI 返回内容无法解析为 JSON');
    const v = JSON.parse(m[0]);
    applyVerdict(c, v, 'ai');
    saveState();
    renderAll();
  });
}

GRTUI.verifyOne = function (id) {
  const c = state.candidates.find(function (x) { return x.id === id; });
  if (!c) return;
  if (!c.name || !GRT.norm(c.name)) { showNote('请先填写公司名称，再执行验证。', 'err'); return; }
  const st = state.settings || {};
  if (st.aiKey && st.aiBaseUrl) {
    showNote('AI 验证中：' + c.name + ' …', 'ok');
    aiVerify(c).catch(function (e) {
      showNote('AI 验证失败：' + e.message + '。可检查接口/Key 配置，或改用内置自动初筛。', 'err');
    });
  } else {
    applyVerdict(c, autoVerify(c), 'auto');
    refreshDedup();
    saveState();
    renderAll();
    const left = ['a', 'b', 'c', 'd', 'e'].filter(function (k) { return !c.checks[k]; })
      .map(function (k) { return { a: '①', b: '②', c: '③', d: '④', e: '⑤' }[k]; }).join('');
    showNote('自动初筛完成。无法自动确认的项（' + (left || '无') +
      '）需配置 AI 接口或工商数据源后点「重新验证」。', 'ok');
  }
};

GRTUI.verifyAll = function () {
  const list = state.candidates.filter(function (c) { return c.name && GRT.norm(c.name); });
  if (!list.length) { showNote('候选池为空或未填写公司名称。', 'err'); return; }
  const st = state.settings || {};
  if (st.aiKey && st.aiBaseUrl) {
    showNote('开始逐家 AI 验证（共 ' + list.length + ' 家）…', 'ok');
    let chain = Promise.resolve();
    list.forEach(function (c) {
      chain = chain.then(function () { return aiVerify(c); });
    });
    chain.catch(function (e) { showNote('AI 验证中断：' + e.message, 'err'); });
  } else {
    list.forEach(function (c) { applyVerdict(c, autoVerify(c), 'auto'); });
    refreshDedup();
    saveState();
    renderAll();
    showNote('已自动初筛 ' + list.length + ' 家。未通过项需配置 AI 接口后点「重新验证」。', 'ok');
  }
};

GRTUI.saveAISettings = function () {
  state.settings = {
    aiBaseUrl: $('ai-base').value.trim(),
    aiKey: $('ai-key').value.trim(),
    aiModel: $('ai-model').value.trim()
  };
  saveState();
  showNote('AI 验证设置已保存（保存在本机浏览器，随「导出数据备份」一起导出）。', 'ok');
};

GRTUI.clearB = function () {
  const n = Object.keys(state.dedupB).length;
  if (!n) { showNote('去重库B为空。', 'err'); return; }
  if (!confirm('确定清空去重库B（' + n + ' 家）？此操作不可恢复，建议先导出数据备份。')) return;
  state.dedupB = {};
  refreshDedup();
  saveState();
  renderAll();
  showNote('去重库B已清空。', 'ok');
};

GRTUI.exportBackup = function () {
  const d = new Date();
  const payload = JSON.stringify({
    app: 'grt-workflow',
    version: 1,
    exportedAt: new Date().toISOString(),
    state: state
  }, null, 2);
  download('光润通数据备份_' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.json',
    payload, 'application/json');
};

GRTUI.importBackup = function (input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function () {
    try {
      const parsed = JSON.parse(String(reader.result));
      if (!parsed || !parsed.state || !Array.isArray(parsed.state.candidates)) {
        throw new Error('格式不正确');
      }
      if (!confirm('导入备份将覆盖当前页面全部数据（候选、去重库B、历史、计数）。是否继续？')) return;
      state = Object.assign(defaultState(), parsed.state);
      refreshDedup();
      saveState();
      renderAll();
      showNote('数据备份导入成功。', 'ok');
    } catch (e) {
      showNote('备份文件解析失败：' + e.message, 'err');
    }
    input.value = '';
  };
  reader.readAsText(file, 'utf-8');
};

GRTUI.clearAll = function () {
  if (!confirm('确定清空本页全部数据（候选、去重库B、历史、计数）？内置去重库A不受影响。建议先导出备份。')) return;
  state = defaultState();
  refreshDedup();
  saveState();
  renderAll();
  $('out-text').value = '';
  showNote('已清空全部数据。', 'ok');
};

/* ---------- 通用工具 ---------- */
function copyText(text, okMsg) {
  const done = function () { showNote(okMsg || '已复制到剪贴板', 'ok'); };
  const fallback = function () {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      showNote('复制失败，请手动全选复制。', 'err');
    }
    document.body.removeChild(ta);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    URL.revokeObjectURL(a.href);
    if (a.remove) a.remove();
    else if (a.parentNode) a.parentNode.removeChild(a);
  }, 200);
}

/* ---------- 初始化 ---------- */
function init() {
  state = loadState();
  rebuildDedupA();
  if ($('ai-base')) $('ai-base').value = state.settings.aiBaseUrl || '';
  if ($('ai-key')) $('ai-key').value = state.settings.aiKey || '';
  if ($('ai-model')) $('ai-model').value = state.settings.aiModel || '';
  refreshDedup();
  renderAll();
  showNote('工具已就绪：首次使用请先载入去重库A（Excel/JSON/TXT），数据只存在本机浏览器。', 'ok');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GRT;
} else if (typeof window !== 'undefined') {
  window.GRT = GRT;
  window.GRTUI = GRTUI;
  if (typeof document !== 'undefined' && document.getElementById) {
    init();
  }
}
