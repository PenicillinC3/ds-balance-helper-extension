/**
 * ============================================================
 * DeepSeek 余额助手 - Popup 交互逻辑
 * ============================================================
 * - 首次打开自动聚焦 API Key 输入框
 * - 密钥输入（防抖）后自动保存并立即查询验证
 * - 阈值 / 提醒开关 / 刷新间隔修改后自动保存
 * - 手动刷新带加载态；后台定时刷新结果通过 storage 变更实时回显
 * - 全平台用量（金额）：导入官方导出包或用登录态自动拉取
 * ============================================================
 */

const DEFAULT_SETTINGS = {
  threshold: 5,
  alertsEnabled: true,
  refreshInterval: 10,
  widgetMode: 'floating',
  trendRange: '7d'
};

const STORAGE_KEYS = [
  'ds_settings', 'ds_last_data', 'ds_last_error', 'ds_api_key', 'ds_bill_imports',
  'ds_balance_history'
];

/** 趋势图的时间档位 */
const TREND_RANGES = {
  '24h': { ms: 24 * 60 * 60 * 1000 },
  '7d': { ms: 7 * 24 * 60 * 60 * 1000 },
  '30d': { ms: 30 * 24 * 60 * 60 * 1000 }
};

/** 画布尺寸：与 popup.css 里的 .trend-svg 保持一致（卡片内宽 284px） */
const TREND_W = 284;
const TREND_H = 90;
/** 最多画这么多个点：再多也只是重复占用像素 */
const TREND_MAX_POINTS = 120;

const el = {
  keyInput: document.getElementById('apiKeyInput'),
  toggleKeyBtn: document.getElementById('toggleKeyBtn'),
  eyeIcon: document.getElementById('eyeIcon'),
  keyHint: document.getElementById('keyHint'),
  thresholdInput: document.getElementById('thresholdInput'),
  alertToggle: document.getElementById('alertToggle'),
  intervalSelect: document.getElementById('intervalSelect'),
  widgetModeSelect: document.getElementById('widgetModeSelect'),
  widgetModeNotice: document.getElementById('widgetModeNotice'),
  widgetModeNoticeClose: document.getElementById('widgetModeNoticeClose'),
  settingsBtn: document.getElementById('settingsBtn'),
  settingsBackBtn: document.getElementById('settingsBackBtn'),
  pages: document.getElementById('pages'),
  mainPage: document.getElementById('mainPage'),
  settingsPage: document.getElementById('settingsPage'),
  refreshBtn: document.getElementById('refreshBtn'),
  refreshIcon: document.getElementById('refreshIcon'),
  balanceValue: document.getElementById('balanceValue'),
  consumedValue: document.getElementById('consumedValue'),
  toppedUpValue: document.getElementById('toppedUpValue'),
  grantedValue: document.getElementById('grantedValue'),
  totalQuotaWrap: document.getElementById('totalQuotaWrap'),
  totalQuotaValue: document.getElementById('totalQuotaValue'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  // 余额趋势
  trendTabs: document.getElementById('trendTabs'),
  trendSvg: document.getElementById('trendSvg'),
  trendMax: document.getElementById('trendMax'),
  trendMin: document.getElementById('trendMin'),
  trendEmpty: document.getElementById('trendEmpty'),
  trendFrom: document.getElementById('trendFrom'),
  trendTo: document.getElementById('trendTo'),
  trendHint: document.getElementById('trendHint'),
  // 全平台账单
  billMonthSelect: document.getElementById('billMonthSelect'),
  billAutoBtn: document.getElementById('billAutoBtn'),
  billDrop: document.getElementById('billDrop'),
  billFileInput: document.getElementById('billFileInput'),
  billWarnings: document.getElementById('billWarnings'),
  billBody: document.getElementById('billBody'),
  billAmount: document.getElementById('billAmount'),
  billWallet: document.getElementById('billWallet'),
  billTokens: document.getElementById('billTokens'),
  billHitRate: document.getElementById('billHitRate'),
  billHit: document.getElementById('billHit'),
  billMiss: document.getElementById('billMiss'),
  billOutput: document.getElementById('billOutput'),
  billRequests: document.getElementById('billRequests'),
  billKeyList: document.getElementById('billKeyList'),
  billModelList: document.getElementById('billModelList'),
  billUpdated: document.getElementById('billUpdated'),
  billClearBtn: document.getElementById('billClearBtn'),
  // 扩展未重新加载提示
  staleNotice: document.getElementById('staleNotice'),
  staleNoticeText: document.getElementById('staleNoticeText'),
  staleNoticeClose: document.getElementById('staleNoticeClose')
};

let refreshing = false;
let keyDebounceTimer = null;
let currentBills = {};       // ds_bill_imports：{ 月份: {agg, source, importedAt, warnings} }
let currentBillMonth = null; // 当前查看的账单月份
let currentHistory = [];     // ds_balance_history：[{t, v}] 后台定时采样的余额
let currentTrendRange = '7d';
let currentSettings = { ...DEFAULT_SETTINGS };

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.ds_settings || {}) };
  currentSettings = settings;

  el.keyInput.value = stored.ds_api_key || '';
  el.thresholdInput.value = settings.threshold;
  el.alertToggle.checked = !!settings.alertsEnabled;
  el.intervalSelect.value = String(settings.refreshInterval);
  el.widgetModeSelect.value = settings.widgetMode || 'floating';

  currentBills = stored.ds_bill_imports || {};
  currentHistory = Array.isArray(stored.ds_balance_history) ? stored.ds_balance_history : [];
  currentTrendRange = TREND_RANGES[settings.trendRange] ? settings.trendRange : '7d';
  initBillMonth();
  renderBill();
  renderTrend();
  renderFromStorage(stored.ds_last_data, stored.ds_last_error);
  bindEvents();

  // 后台自动刷新 / 自动拉取导致的数据变化，实时同步到弹窗
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ds_last_data || changes.ds_last_error) {
      chrome.storage.local.get(['ds_last_data', 'ds_last_error']).then((s) => {
        renderFromStorage(s.ds_last_data, s.ds_last_error);
      });
    }
    if (changes.ds_balance_history) {
      currentHistory = Array.isArray(changes.ds_balance_history.newValue)
        ? changes.ds_balance_history.newValue
        : [];
      renderTrend();
    }
    if (changes.ds_bill_imports) {
      currentBills = changes.ds_bill_imports.newValue || {};
      // 后台自动拉取写入后，若出现新月份，自动切到新月份
      const months = billMonths();
      if (!currentBillMonth || !months.includes(currentBillMonth)) {
        currentBillMonth = months[0] || null;
      }
      renderBill();
    }
  });

  if (stored.ds_api_key) {
    // 已有有效 Key：设置面板默认收起，主界面只展示余额与用量，保持简洁
    setSettingsOpen(false);
    // 已有密钥但从未成功拿到数据（如刚装好扩展）：打开弹窗时自动查一次
    if (!stored.ds_last_data) {
      doRefresh();
    }
  } else {
    // 首次打开且未配置密钥：自动展开设置面板并聚焦输入框，引导用户输入
    setSettingsOpen(true, true);
  }

  checkBackgroundAlive();
}

/**
 * 自检：后台是否为「同一份代码」。
 *
 * 扩展以「加载已解压的扩展程序」方式使用时，改动磁盘上的文件不会自动生效——
 * 弹窗每次打开都会重新读盘，而 service worker 一旦启动就一直跑内存里的旧版本。
 * 两者版本不一致（或后台完全不响应）时，功能会以难以理解的方式失败，
 * 所以这里主动提示用户重新加载扩展。
 */
async function checkBackgroundAlive() {
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'DS_PING' });
  } catch (e) {
    resp = null;
  }

  const myVersion = chrome.runtime.getManifest().version;

  if (!resp || !resp.ok) {
    showStaleNotice(`扩展后台未响应，功能可能无法使用。请在扩展管理页（chrome://extensions）点「重新加载」后重试。`);
    return;
  }
  if (resp.version !== myVersion) {
    showStaleNotice(`扩展后台仍是旧版本（界面 ${myVersion} / 后台 ${resp.version}），请到扩展管理页点「重新加载」以应用更新。`);
  }
}

function showStaleNotice(text) {
  el.staleNoticeText.textContent = text;
  el.staleNotice.hidden = false;
  requestAnimationFrame(() => layoutPages());
}

function hideStaleNotice() {
  el.staleNotice.hidden = true;
  requestAnimationFrame(() => layoutPages());
}

/**
 * 左右滑动切换设置页
 * @param {boolean} open true=设置页从右侧滑入，false=滑回主页面
 * @param {boolean} focusInput 滑入后是否聚焦 API Key 输入框
 */
function setSettingsOpen(open, focusInput) {
  const show = !!open;
  el.pages.classList.toggle('show-settings', show);
  el.settingsBtn.classList.toggle('active', show);
  el.settingsBtn.setAttribute('aria-expanded', String(show));
  el.settingsPage.setAttribute('aria-hidden', String(!show));
  layoutPages();
  if (show && focusInput) {
    // 等滑动过渡结束后再聚焦，避免浏览器为聚焦元素强制滚动
    setTimeout(() => el.keyInput.focus(), 320);
  }
}

/**
 * 页面轨道高度自适应当前可见页（设置页为绝对定位，不占据文档流）
 */
function layoutPages() {
  const active = el.pages.classList.contains('show-settings')
    ? el.settingsPage
    : el.mainPage;
  const h = active.offsetHeight;
  if (h > 0) el.pages.style.height = `${h}px`;
}

function bindEvents() {
  // 显示 / 隐藏密钥
  el.toggleKeyBtn.addEventListener('click', () => {
    const isPassword = el.keyInput.type === 'password';
    el.keyInput.type = isPassword ? 'text' : 'password';
    el.eyeIcon.style.opacity = isPassword ? '1' : '0.55';
  });

  // 密钥输入：防抖 700ms 自动保存 + 验证查询
  el.keyInput.addEventListener('input', () => {
    el.keyInput.classList.remove('invalid');
    clearTimeout(keyDebounceTimer);
    const value = el.keyInput.value.trim();
    if (!value) {
      saveApiKey('');
      setStatus('idle', '请输入 API Key');
      return;
    }
    keyDebounceTimer = setTimeout(() => {
      saveApiKey(value).then(() => doRefresh());
    }, 700);
  });

  // 预警阈值：失焦 / 回车时保存（避免输入过程中被改写）
  el.thresholdInput.addEventListener('change', saveSettingsFromForm);
  el.alertToggle.addEventListener('change', saveSettingsFromForm);
  el.intervalSelect.addEventListener('change', saveSettingsFromForm);
  // 浮窗显示模式更改：保存后展开“请刷新页面”提醒
  el.widgetModeSelect.addEventListener('change', async () => {
    await saveSettingsFromForm();
    showWidgetModeNotice();
  });
  el.widgetModeNoticeClose.addEventListener('click', hideWidgetModeNotice);
  el.staleNoticeClose.addEventListener('click', hideStaleNotice);

  // 齿轮：切换设置页滑入 / 滑出
  el.settingsBtn.addEventListener('click', () => {
    setSettingsOpen(!el.pages.classList.contains('show-settings'));
  });
  // 设置页左上角返回箭头
  el.settingsBackBtn.addEventListener('click', () => setSettingsOpen(false));

  // 两页内容高度变化（数据渲染等）时，容器高度始终贴合当前页
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => layoutPages());
    ro.observe(el.mainPage);
    ro.observe(el.settingsPage);
  }
  window.addEventListener('resize', layoutPages);

  // 手动刷新余额
  el.refreshBtn.addEventListener('click', doRefresh);

  // 趋势时间档位切换
  el.trendTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.trend-tab');
    if (!btn || !TREND_RANGES[btn.dataset.range]) return;
    currentTrendRange = btn.dataset.range;
    chrome.storage.local.get('ds_settings').then((s) => {
      chrome.storage.local.set({
        ds_settings: { ...DEFAULT_SETTINGS, ...(s.ds_settings || {}), trendRange: currentTrendRange }
      });
    });
    renderTrend();
  });

  // 账单：月份切换、文件选择、拖拽导入、自动拉取、清空
  el.billMonthSelect.addEventListener('change', () => {
    currentBillMonth = el.billMonthSelect.value || null;
    renderBill();
  });
  el.billDrop.addEventListener('click', () => el.billFileInput.click());
  el.billDrop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') el.billFileInput.click();
  });
  el.billFileInput.addEventListener('change', () => {
    importBillFiles(Array.from(el.billFileInput.files || []));
    el.billFileInput.value = ''; // 允许重复导入同一文件
  });
  ['dragenter', 'dragover'].forEach((evt) => {
    el.billDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      el.billDrop.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach((evt) => {
    el.billDrop.addEventListener(evt, (e) => {
      e.preventDefault();
      el.billDrop.classList.remove('dragover');
    });
  });
  el.billDrop.addEventListener('drop', (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length) importBillFiles(files);
  });
  el.billAutoBtn.addEventListener('click', autoFetchBill);
  el.billClearBtn.addEventListener('click', clearBills);
}

/* ------------------------------ 余额趋势 ------------------------------ */

/**
 * 画余额随时间的曲线。
 *
 * 数据是后台每次成功查询余额时顺手记下的采样点，所以：
 *   - 它只覆盖「浏览器开着」的时段，跨过没观测的时段画虚线（见 trend.js）；
 *   - 装好当天没有历史，要养一段时间才有东西看。
 */
function renderTrend() {
  const range = TREND_RANGES[currentTrendRange] || TREND_RANGES['7d'];
  const now = Date.now();

  // 高亮当前档位
  Array.from(el.trendTabs.children).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === currentTrendRange);
  });

  const inRange = DS_TREND.sliceRange(currentHistory, now - range.ms, now);
  const series = DS_TREND.buildSeries(inRange, {
    width: TREND_W,
    height: TREND_H,
    padX: 2,
    padY: 12,
    gapMs: trendGapMs(),
    maxPoints: TREND_MAX_POINTS
  });

  if (series.count < 2) {
    el.trendSvg.innerHTML = '';
    el.trendMax.textContent = '';
    el.trendMin.textContent = '';
    el.trendFrom.textContent = '—';
    el.trendTo.textContent = '—';
    el.trendHint.textContent = '';
    // 区分「还没有任何采样」和「这段窗口内没有采样」——两者的下一步动作不同
    el.trendEmpty.textContent = currentHistory.length
      ? '所选时段内没有采样记录'
      : '趋势数据从今天开始积累';
    el.trendEmpty.hidden = false;
    requestAnimationFrame(() => layoutPages());
    return;
  }

  el.trendEmpty.hidden = true;

  const parts = [];
  let hasGap = false;
  series.paths.forEach((p) => {
    if (p.dashed) hasGap = true;
    parts.push(
      `<path d="${p.d}" fill="none" stroke="#4d6bfe" stroke-width="1.6" ` +
      `stroke-linejoin="round" stroke-linecap="round"` +
      (p.dashed ? ' stroke-dasharray="3 3" opacity="0.4"' : '') + '/>'
    );
  });
  series.dots.forEach((d) => {
    parts.push(`<circle cx="${d.x}" cy="${d.y}" r="2" fill="#4d6bfe"/>`);
  });
  if (series.last) {
    // 末点＝当前余额，单独标出来
    parts.push(`<circle cx="${series.last.x}" cy="${series.last.y}" r="6" fill="#4d6bfe" opacity="0.16"/>`);
    parts.push(`<circle cx="${series.last.x}" cy="${series.last.y}" r="2.6" fill="#4d6bfe"/>`);
  }
  el.trendSvg.innerHTML = parts.join('');

  // Y 轴不从 0 起，所以必须把上下界标出来，否则纵向变化会被误读成很大
  el.trendMax.textContent = `¥${formatMoney(series.max)}`;
  el.trendMin.textContent = series.min === series.max ? '' : `¥${formatMoney(series.min)}`;

  el.trendFrom.textContent = formatTrendTime(inRange[0].t);
  el.trendTo.textContent = formatTrendTime(inRange[inRange.length - 1].t);
  el.trendHint.textContent = hasGap ? '虚线＝未观测时段' : '';

  requestAnimationFrame(() => layoutPages());
}

/**
 * 判定「这段没在观测」的间隔阈值。
 * 必须跟着用户设置的刷新间隔走：间隔设成 60 分钟时，若还用固定的 30 分钟，
 * 整条曲线会段段都是虚线。取 3 倍留出闹钟抖动与偶尔漏一次的余量。
 */
function trendGapMs() {
  const minutes = Number(currentSettings.refreshInterval) || DEFAULT_SETTINGS.refreshInterval;
  return Math.max(minutes, 1) * 60 * 1000 * 3;
}

function formatTrendTime(ts) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  // 24 小时档看的是时刻，更长的档看的是日期
  return currentTrendRange === '24h'
    ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/* ------------------------ 全平台账单（金额） ------------------------ */

/** 月份列表（降序，含可能的“未识别”） */
function billMonths() {
  return Object.keys(currentBills).sort((a, b) => (a < b ? 1 : -1));
}

/** 初始化账单月份：默认最新月份 */
function initBillMonth() {
  const months = billMonths();
  currentBillMonth = months[0] || null;
}

/** 渲染整个账单面板（月份下拉 + 金额 + 明细） */
function renderBill() {
  const months = billMonths();

  // 月份下拉
  el.billMonthSelect.innerHTML = months.map((m) =>
    `<option value="${escapeHtml(m)}">${m === 'unknown' ? '未识别月份' : m}</option>`
  ).join('');
  if (currentBillMonth && months.includes(currentBillMonth)) {
    el.billMonthSelect.value = currentBillMonth;
  } else {
    currentBillMonth = months[0] || null;
  }

  const entry = currentBillMonth ? currentBills[currentBillMonth] : null;
  if (!entry || !entry.agg) {
    el.billBody.hidden = true;
    el.billWarnings.hidden = true;
    el.billUpdated.textContent = '尚未导入账单';
    requestAnimationFrame(() => layoutPages());
    return;
  }

  const t = entry.agg.total || { amount: 0, rows: 0 };
  el.billBody.hidden = false;
  el.billAmount.textContent = formatMoney(t.amount);
  renderWallet(entry.agg.wallet);
  renderTokens(tokensOf(t));
  renderBreakdown(el.billKeyList, entry.agg.byKey);
  renderBreakdown(el.billModelList, entry.agg.byModel);

  // 警告（缺文件等）
  const ws = Array.isArray(entry.warnings) ? entry.warnings : [];
  if (ws.length) {
    el.billWarnings.hidden = false;
    el.billWarnings.innerHTML = ws.map((w) =>
      `<div class="bill-warn-row">${escapeHtml(w)}</div>`
    ).join('');
  } else {
    el.billWarnings.hidden = true;
  }

  const srcLabel = entry.source === 'auto' ? '自动拉取' : '文件导入';
  el.billUpdated.textContent = `${srcLabel}于 ${formatTime(entry.importedAt)}`;
  requestAnimationFrame(() => layoutPages());
}

/** 充值 / 赠送消费拆分（官方 cost 明细按 wallet_type 给出） */
function renderWallet(wallet) {
  const entries = Object.entries(wallet || {}).filter(([, v]) => v > 0);
  if (!entries.length) {
    el.billWallet.hidden = true;
    el.billWallet.innerHTML = '';
    return;
  }
  const label = { Paid: '充值余额', Granted: '赠送余额' };
  el.billWallet.hidden = false;
  el.billWallet.innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="wallet-chip">${escapeHtml(label[k] || k)} ¥${formatMoney(v)}</span>`)
    .join('');
}

/**
 * 取一个分组里的 token 计数。
 * 旧版本（1.4.x）导入的账单没有这个字段，此时返回 null，界面按「无 token 数据」处理。
 */
function tokensOf(group) {
  const t = group && group.tokens;
  if (!t || typeof t !== 'object') return null;
  return {
    hit: Number(t.hit) || 0,
    miss: Number(t.miss) || 0,
    output: Number(t.output) || 0,
    requests: Number(t.requests) || 0
  };
}

/** 缓存命中率 = 命中 / (命中 + 未命中)，即输入 token 的命中占比 */
function hitRateOf(tk) {
  const input = tk.hit + tk.miss;
  return input > 0 ? (tk.hit / input) * 100 : null;
}

/**
 * 渲染 Token 用量总览：缓存命中 / 未命中 / 输出 / 请求次数 + 命中率。
 * 没有任何 token 数据时整块隐藏（例如只导入了花费明细，或旧版本存的账单）。
 */
function renderTokens(tk) {
  const hasAny = tk && (tk.hit || tk.miss || tk.output || tk.requests);
  if (!hasAny) {
    el.billTokens.hidden = true;
    return;
  }

  el.billTokens.hidden = false;
  setTokenStat(el.billHit, tk.hit);
  setTokenStat(el.billMiss, tk.miss);
  setTokenStat(el.billOutput, tk.output);
  setTokenStat(el.billRequests, tk.requests, ' 次');

  const rate = hitRateOf(tk);
  el.billHitRate.textContent = rate == null ? '命中率 —' : `命中率 ${rate.toFixed(1)}%`;
}

/** 大数用「万 / 亿」缩写显示，鼠标悬停可看完整数字 */
function setTokenStat(node, value, unit) {
  node.textContent = formatTokens(value) + (unit || '');
  node.title = `${formatCount(value)}${unit || ''}`;
}

/**
 * 渲染分 Key / 分模型金额明细（按金额降序，最多 8 行）。
 * 副标题同时给出调用次数与缓存命中 / 未命中 token。
 */
function renderBreakdown(container, groups) {
  const names = Object.keys(groups || {});
  names.sort((a, b) => groups[b].amount - groups[a].amount);
  if (!names.length) {
    container.innerHTML = '<div class="bill-empty">无明细</div>';
    return;
  }
  container.innerHTML = names.slice(0, 8).map((name) => {
    const g = groups[name];
    return `<div class="bill-row">
      <div class="bill-row-left">
        <div class="bill-row-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="bill-row-sub" title="${escapeHtml(breakdownTitle(g))}">${escapeHtml(breakdownSub(g))}</div>
      </div>
      <div class="bill-row-right">¥${formatMoney(g.amount)}</div>
    </div>`;
  }).join('');
}

/**
 * 明细行的副标题：有 token 数据时展示缓存命中 / 未命中。
 * 弹窗只有 340px 宽，这里只放最短的两个数；调用次数与精确值放进悬停提示。
 */
function breakdownSub(g) {
  const tk = tokensOf(g);
  if (!tk || (!tk.hit && !tk.miss)) {
    return tk && tk.requests ? `${formatCount(tk.requests)} 次调用` : `${g.rows} 条记录`;
  }
  return `命中 ${formatTokens(tk.hit)} / 未命中 ${formatTokens(tk.miss)}`;
}

/** 明细行的悬停提示：调用次数 + 全部 token 精确值 */
function breakdownTitle(g) {
  const tk = tokensOf(g);
  if (!tk || (!tk.hit && !tk.miss && !tk.requests)) return `${g.rows} 条记录`;
  return [
    `${formatCount(tk.requests)} 次调用`,
    `缓存命中 ${formatCount(tk.hit)}`,
    `缓存未命中 ${formatCount(tk.miss)}`,
    `输出 ${formatCount(tk.output)}`
  ].join(' · ');
}

/**
 * 导入用户选择的文件（zip / csv），解析后按月合并入 ds_bill_imports。
 * 同一月份重复导入时直接覆盖（以最新文件为准）。
 */
async function importBillFiles(files) {
  if (!files || !files.length) return;
  el.billAutoBtn.disabled = true;
  el.billUpdated.textContent = '正在解析账单文件…';
  let result;
  try {
    result = await DS_BILL.parseFiles(files);
  } catch (e) {
    el.billUpdated.textContent = '解析失败：' + (e && e.message ? e.message : e);
    el.billAutoBtn.disabled = false;
    return;
  }

  if (!result.records.length) {
    // 解析不到任何记录：保留警告并展示
    const month = result.month || 'unknown';
    currentBills = {
      ...currentBills,
      [month]: {
        agg: DS_BILL.aggregate([]),
        source: 'csv',
        importedAt: Date.now(),
        warnings: result.warnings.length ? result.warnings : ['未从文件中解析到任何金额记录']
      }
    };
    currentBillMonth = month;
    await chrome.storage.local.set({ ds_bill_imports: currentBills });
    renderBill();
    el.billAutoBtn.disabled = false;
    return;
  }

  // 按月分别归档：一次多选导入可能包含好几个月，不能并进同一个桶
  const byMonth = DS_BILL.aggregateByMonth(result.records);
  const next = { ...currentBills };
  Object.keys(byMonth).forEach((month) => {
    next[month] = {
      agg: byMonth[month].agg,
      source: 'csv',
      importedAt: Date.now(),
      files: result.files,
      warnings: result.warnings
    };
  });
  currentBills = next;

  const months = billMonths();
  currentBillMonth = months.includes(currentBillMonth) ? currentBillMonth : (months[0] || null);

  await chrome.storage.local.set({ ds_bill_imports: currentBills });
  renderBill();
  el.billAutoBtn.disabled = false;
}

/** 让后台用登录态自动拉取用量 */
async function autoFetchBill() {
  el.billAutoBtn.disabled = true;
  el.billUpdated.textContent = '正在用登录态自动拉取…';
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'DS_BILL_FETCH',
      month: currentBillMonth || null // 拉取当前查看的月份，未选时由后台取当月
    });
  } catch (e) {
    resp = { ok: false, message: '后台服务未响应，请关闭弹窗后重新打开' };
  }
  el.billAutoBtn.disabled = false;
  if (!resp || !resp.ok) {
    // 把失败原因连同细节一起展示，而不是只给一句"失败"
    const message = (resp && resp.message) ||
      '后台没有响应，扩展可能未重新加载：请到扩展管理页点「重新加载」后重试';
    const rows = [`<div class="bill-warn-row">${escapeHtml(message)}</div>`];
    if (resp && resp.code) {
      rows.push(`<div class="bill-warn-row">错误码：${escapeHtml(resp.code)}</div>`);
    }
    const details = resp && Array.isArray(resp.details) ? resp.details : [];
    details.forEach((d) => rows.push(`<div class="bill-warn-row">${escapeHtml(d)}</div>`));
    el.billWarnings.hidden = false;
    el.billWarnings.innerHTML = rows.join('');
    el.billUpdated.textContent = '自动拉取未成功（可先手动导入）';
    requestAnimationFrame(() => layoutPages());
  }
  // 成功时 storage.onChanged 会自动驱动 renderBill
}

async function clearBills() {
  currentBills = {};
  currentBillMonth = null;
  await chrome.storage.local.set({ ds_bill_imports: null });
  renderBill();
}

/* ------------------------------ 存储操作 ------------------------------ */

function saveApiKey(key) {
  return chrome.storage.local.set({ ds_api_key: key });
}

/** 展开“浮窗模式已更改，请刷新页面”提醒条（带展开过渡） */
function showWidgetModeNotice() {
  el.widgetModeNotice.classList.add('show');
  // 设置页高度可能因提醒条展开而变化，下一帧重新贴合容器高度
  requestAnimationFrame(() => layoutPages());
}

function hideWidgetModeNotice() {
  el.widgetModeNotice.classList.remove('show');
  requestAnimationFrame(() => layoutPages());
}

async function saveSettingsFromForm() {
  const stored = await chrome.storage.local.get('ds_settings');
  const prev = { ...DEFAULT_SETTINGS, ...(stored.ds_settings || {}) };

  let threshold = parseFloat(el.thresholdInput.value);
  if (!Number.isFinite(threshold) || threshold < 0) {
    threshold = DEFAULT_SETTINGS.threshold; // 非法值回退默认
    el.thresholdInput.value = threshold;
  }

  const widgetMode = ['floating', 'pinned', 'off'].includes(el.widgetModeSelect.value)
    ? el.widgetModeSelect.value
    : DEFAULT_SETTINGS.widgetMode;

  const next = {
    threshold,
    alertsEnabled: el.alertToggle.checked,
    refreshInterval: parseInt(el.intervalSelect.value, 10) || DEFAULT_SETTINGS.refreshInterval,
    widgetMode,
    // 趋势档位不在设置页里，但这里整体重写 ds_settings，必须原样带过去
    trendRange: prev.trendRange || DEFAULT_SETTINGS.trendRange
  };

  await chrome.storage.local.set({ ds_settings: next });
  currentSettings = next;
  // 刷新间隔会影响「多长算没观测」，趋势图要跟着重画
  renderTrend();

  // 关闭提醒时清除旧的低余额状态标记，下次重新开启可正常提醒
  if (!next.alertsEnabled && prev.alertsEnabled) {
    await chrome.storage.local.set({ ds_alert: { state: 'ok' } });
  }
}

/* ------------------------------ 刷新流程 ------------------------------ */

async function doRefresh() {
  if (refreshing) return;

  const key = el.keyInput.value.trim();
  if (!key) {
    el.keyInput.classList.add('invalid');
    setStatus('error', '请先输入 API Key');
    el.keyInput.focus();
    return;
  }

  setLoading(true);
  setStatus('loading', '正在查询最新余额…');

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'DS_REFRESH' });
  } catch (err) {
    // Service Worker 未就绪等极端情况
    setLoading(false);
    setStatus('error', '后台服务未响应，请关闭弹窗后重新打开');
    return;
  }

  setLoading(false);

  // 正常情况下 storage.onChanged 已经驱动界面刷新；
  // 这里仅兜底处理后台未落盘的错误（如未配置 Key）
  if (!resp || !resp.ok) {
    const message = (resp && resp.message) || '查询失败，请稍后重试';
    setStatus('error', message);
    if (resp && (resp.error === 'AUTH' || resp.error === 'NO_KEY')) {
      el.keyInput.classList.add('invalid');
    }
  }
}

function setLoading(loading) {
  refreshing = loading;
  el.refreshBtn.classList.toggle('loading', loading);
  el.refreshBtn.disabled = loading;
}

/* ------------------------------ 界面渲染 ------------------------------ */

function renderFromStorage(data, error) {
  if (data && typeof data.available === 'number') {
    el.balanceValue.textContent = formatMoney(data.available);
    el.consumedValue.textContent = `¥${formatMoney(data.consumed || 0)}`;
    el.toppedUpValue.textContent = data.toppedUp == null ? '—' : `¥${formatMoney(data.toppedUp)}`;
    el.grantedValue.textContent = data.granted == null ? '—' : `¥${formatMoney(data.granted)}`;

    // 总额度：仅当接口返回时显示
    if (data.totalQuota != null) {
      el.totalQuotaWrap.hidden = false;
      el.totalQuotaValue.textContent = `¥${formatMoney(data.totalQuota)}`;
    } else {
      el.totalQuotaWrap.hidden = true;
    }
  }

  // 错误优先展示；有历史成功数据时附带上次成功时间
  if (error && error.message) {
    setStatus('error', error.message);
    if (error.error === 'AUTH') el.keyInput.classList.add('invalid');
    if (data && data.fetchedAt) {
      el.statusText.textContent += `（上次成功更新 ${formatTime(data.fetchedAt)}）`;
    }
  } else if (data && data.fetchedAt) {
    setStatus('ok', `上次更新：${formatTime(data.fetchedAt)}`);
  } else {
    setStatus('idle', '尚未查询');
  }
}

function setStatus(kind, text) {
  el.statusDot.className = `status-dot ${kind === 'idle' ? '' : kind}`;
  el.statusText.className = `status-text ${kind === 'error' ? 'error' : ''}`;
  el.statusText.textContent = text;
}

/* ------------------------------ 工具函数 ------------------------------ */

function formatMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '--.--';
  return num.toFixed(2);
}

/** 整数 + 千分位（用于 token 数 / 请求次数） */
function formatCount(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Token 数量：过万 / 过亿时缩写，避免在 340px 宽的弹窗里撑破排版 */
function formatTokens(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(2)} 万`;
  return formatCount(v);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

document.addEventListener('DOMContentLoaded', init);
