/**
 * ============================================================
 * DeepSeek 余额助手 - Popup 交互逻辑
 * ============================================================
 * - 首次打开自动聚焦 API Key 输入框
 * - 密钥输入（防抖）后自动保存并立即查询验证
 * - 阈值 / 提醒开关 / 刷新间隔修改后自动保存
 * - 手动刷新带加载态；后台定时刷新结果通过 storage 变更实时回显
 * ============================================================
 */

const DEFAULT_SETTINGS = {
  threshold: 5,
  alertsEnabled: true,
  refreshInterval: 10,
  widgetMode: 'floating'
};

const STORAGE_KEYS = ['ds_settings', 'ds_last_data', 'ds_last_error', 'ds_api_key', 'ds_usage', 'ds_sites'];
const STATIC_MONITOR_SITE = 'https://platform.deepseek.com';

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
  // token 用量
  scopeTodayBtn: document.getElementById('scopeTodayBtn'),
  scopeTotalBtn: document.getElementById('scopeTotalBtn'),
  hitTokens: document.getElementById('hitTokens'),
  missTokens: document.getElementById('missTokens'),
  hitBarFill: document.getElementById('hitBarFill'),
  hitRate: document.getElementById('hitRate'),
  promptTokens: document.getElementById('promptTokens'),
  completionTokens: document.getElementById('completionTokens'),
  totalTokens: document.getElementById('totalTokens'),
  requestCount: document.getElementById('requestCount'),
  modelList: document.getElementById('modelList'),
  resetUsageBtn: document.getElementById('resetUsageBtn'),
  // 监控站点
  siteInput: document.getElementById('siteInput'),
  addSiteBtn: document.getElementById('addSiteBtn'),
  siteList: document.getElementById('siteList'),
  siteHint: document.getElementById('siteHint')
};

let refreshing = false;
let keyDebounceTimer = null;
let usageScope = 'today'; // today | total
let currentUsage = null;
let currentSites = [];

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS);
  const settings = { ...DEFAULT_SETTINGS, ...(stored.ds_settings || {}) };

  el.keyInput.value = stored.ds_api_key || '';
  el.thresholdInput.value = settings.threshold;
  el.alertToggle.checked = !!settings.alertsEnabled;
  el.intervalSelect.value = String(settings.refreshInterval);
  el.widgetModeSelect.value = settings.widgetMode || 'floating';

  currentUsage = stored.ds_usage || null;
  currentSites = Array.isArray(stored.ds_sites) ? stored.ds_sites : [];
  renderUsage();
  renderSites();
  renderFromStorage(stored.ds_last_data, stored.ds_last_error);
  bindEvents();

  // 后台自动刷新 / 内容脚本上报导致的数据变化，实时同步到弹窗
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.ds_last_data || changes.ds_last_error) {
      chrome.storage.local.get(['ds_last_data', 'ds_last_error']).then((s) => {
        renderFromStorage(s.ds_last_data, s.ds_last_error);
      });
    }
    if (changes.ds_usage) {
      currentUsage = changes.ds_usage.newValue || null;
      renderUsage();
    }
    if (changes.ds_sites) {
      currentSites = changes.ds_sites.newValue || [];
      renderSites();
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

  // 齿轮：切换设置页滑入 / 滑出
  el.settingsBtn.addEventListener('click', () => {
    setSettingsOpen(!el.pages.classList.contains('show-settings'));
  });
  // 设置页左上角返回箭头
  el.settingsBackBtn.addEventListener('click', () => setSettingsOpen(false));

  // 两页内容高度变化（数据渲染、站点增删等）时，容器高度始终贴合当前页
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => layoutPages());
    ro.observe(el.mainPage);
    ro.observe(el.settingsPage);
  }
  window.addEventListener('resize', layoutPages);

  // 手动刷新
  el.refreshBtn.addEventListener('click', doRefresh);

  // Token 用量：今日 / 累计切换、清空
  el.scopeTodayBtn.addEventListener('click', () => setUsageScope('today'));
  el.scopeTotalBtn.addEventListener('click', () => setUsageScope('total'));
  el.resetUsageBtn.addEventListener('click', resetUsage);

  // 监控站点
  el.addSiteBtn.addEventListener('click', addSite);
  el.siteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addSite();
  });
}

/* ------------------------ Token 用量渲染 ------------------------ */

function setUsageScope(scope) {
  usageScope = scope;
  el.scopeTodayBtn.classList.toggle('active', scope === 'today');
  el.scopeTotalBtn.classList.toggle('active', scope === 'total');
  renderUsage();
}

function renderUsage() {
  const b = currentUsage
    ? (usageScope === 'today' ? currentUsage.today : currentUsage.total)
    : null;

  const requests = b ? b.requests : 0;
  const hit = b ? b.hit : 0;
  const miss = b ? b.miss : 0;
  const prompt = b ? b.prompt : 0;
  const completion = b ? b.completion : 0;
  const total = b ? b.total : 0;

  el.hitTokens.textContent = formatTokens(hit);
  el.hitTokens.title = `${hit.toLocaleString('en-US')} tokens`;
  el.missTokens.textContent = formatTokens(miss);
  el.missTokens.title = `${miss.toLocaleString('en-US')} tokens`;
  el.promptTokens.textContent = formatTokens(prompt);
  el.completionTokens.textContent = formatTokens(completion);
  el.totalTokens.textContent = formatTokens(total);
  el.requestCount.textContent = requests.toLocaleString('en-US');

  const inputBase = hit + miss;
  const rate = inputBase > 0 ? (hit / inputBase) * 100 : 0;
  el.hitBarFill.style.width = `${rate.toFixed(1)}%`;
  el.hitRate.textContent = inputBase > 0
    ? `缓存命中率 ${rate.toFixed(1)}%`
    : '缓存命中率 --';

  // 按模型明细（仅累计视图展示完整分组）
  const models = currentUsage && currentUsage.models ? currentUsage.models : {};
  const names = Object.keys(models).sort((a, b2) => models[b2].requests - models[a].requests);
  if (usageScope === 'total' && names.length) {
    el.modelList.innerHTML = names.slice(0, 5).map((name) => {
      const m = models[name];
      return `<div class="model-row">
        <span class="model-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="model-tokens">${m.requests} 次 · ${formatTokens(m.total)}</span>
      </div>`;
    }).join('');
  } else {
    el.modelList.innerHTML = '';
  }
}

async function resetUsage() {
  await chrome.storage.local.set({ ds_usage: null });
  currentUsage = null;
  renderUsage();
}

/* ------------------------ 监控站点管理 ------------------------ */

function renderSites() {
  const chips = [
    `<span class="site-chip static" title="内置静态监控">
       <span class="site-name">${STATIC_MONITOR_SITE}</span>
     </span>`
  ];
  currentSites.forEach((origin) => {
    chips.push(`<span class="site-chip">
      <span class="site-name" title="${escapeHtml(origin)}">${escapeHtml(origin)}</span>
      <button class="chip-x" type="button" data-site="${escapeHtml(origin)}" title="移除">&times;</button>
    </span>`);
  });
  el.siteList.innerHTML = chips.join('');

  el.siteList.querySelectorAll('.chip-x').forEach((btn) => {
    btn.addEventListener('click', () => removeSite(btn.dataset.site));
  });
}

async function addSite() {
  const raw = el.siteInput.value.trim();
  if (!raw) return;

  let origin;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
    origin = u.origin;
  } catch (e) {
    setSiteHint('网址格式不正确，请输入如 https://chat.example.com 的网址', true);
    return;
  }

  if (origin === STATIC_MONITOR_SITE || currentSites.includes(origin)) {
    setSiteHint('该站点已在监控列表中', true);
    return;
  }

  const pattern = origin + '/*';
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (e) {
    granted = false;
  }
  if (!granted) {
    setSiteHint('未授予站点权限，已取消添加', true);
    return;
  }

  const next = [...currentSites, origin];
  await chrome.storage.local.set({ ds_sites: next }); // storage 变更会触发 SW 动态注册
  currentSites = next;
  renderSites();
  el.siteInput.value = '';
  setSiteHint('已添加，请刷新该网页后生效', false);
}

async function removeSite(origin) {
  try {
    await chrome.permissions.remove({ origins: [origin + '/*'] });
  } catch (e) { /* 忽略，仍从列表移除 */ }
  const next = currentSites.filter((s) => s !== origin);
  await chrome.storage.local.set({ ds_sites: next });
  currentSites = next;
  renderSites();
}

function setSiteHint(text, isError) {
  el.siteHint.textContent = text;
  el.siteHint.classList.toggle('error', !!isError);
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
    widgetMode
  };

  await chrome.storage.local.set({ ds_settings: next });

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

/** token 大数紧凑显示：1234 -> 1,234；12.3k；1.2M；精确值放 title */
function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`;
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 10000) return `${(num / 1000).toFixed(1)}k`;
  return num.toLocaleString('en-US');
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
