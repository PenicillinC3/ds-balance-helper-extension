/**
 * ============================================================
 * widget.js - 应用内浮窗（ISOLATED world 内容脚本，仅顶层框架注入）
 * ============================================================
 * 在 DeepSeek 平台页 / 用户添加的监控站点内显示余额浮窗：
 *   - floating：可自由拖拽的悬浮窗（默认，位置本地记忆）
 *   - pinned ：固定在页面右上角常驻
 *   - off    ：不显示（设置面板中可切换回来）
 * 数据来自 chrome.storage.local（由后台 service worker 定时刷新），
 * 完整保留余额展示、token 用量（命中/未命中）、低余额预警提示。
 *
 * 样式与事件全部封装在 Shadow DOM 内，不污染宿主页，也不受宿主页样式影响。
 * ============================================================
 */

(function () {
  'use strict';

  // 仅顶层框架、仅注入一次
  if (window.top !== window) return;
  if (window.__DS_WIDGET_BOOTED__) return;
  window.__DS_WIDGET_BOOTED__ = true;

  const STORAGE_KEYS = ['ds_settings', 'ds_last_data', 'ds_last_error', 'ds_api_key', 'ds_usage', 'ds_widget_pos'];
  const DEFAULT_SETTINGS = { threshold: 5, alertsEnabled: true, refreshInterval: 10, widgetMode: 'floating' };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    data: null,
    error: null,
    usage: null,
    key: '',
    pos: null
  };

  /* ----------------------------- 纯函数（便于测试） ----------------------------- */

  function formatMoney(n) {
    const num = Number(n);
    return Number.isFinite(num) ? num.toFixed(2) : '--.--';
  }

  function formatTokens(n) {
    const num = Number(n) || 0;
    if (num >= 100000000) return (num / 100000000).toFixed(1) + '亿';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 10000) return (num / 1000).toFixed(1) + 'k';
    return num.toLocaleString('en-US');
  }

  function formatTime(ts) {
    if (!ts) return '--';
    const d = new Date(ts);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function clamp(v, min, max) {
    return Math.min(Math.max(v, min), max);
  }

  /** 是否处于低余额状态（与后台通知口径一致：余额 <= 阈值且提醒开启） */
  function shouldAlert(balance, settings) {
    const t = Number(settings && settings.threshold);
    const b = Number(balance);
    return !!(settings && settings.alertsEnabled !== false &&
      Number.isFinite(b) && Number.isFinite(t) && b <= t);
  }

  /** 缓存命中率（0-100），无输入数据时返回 null */
  function hitRate(hit, miss) {
    const h = Number(hit) || 0;
    const m = Number(miss) || 0;
    return h + m > 0 ? (h / (h + m)) * 100 : null;
  }

  /* ----------------------------- Shadow DOM 构建 ----------------------------- */

  const STYLE = `
    :host {
      position: fixed;
      top: 80px;
      right: 16px;
      z-index: 2147483600;
      display: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    }
    :host(.floating), :host(.pinned) { display: block; }
    :host(.pinned) { top: 16px; right: 16px; left: auto; bottom: auto; }
    :host(.dragging) { user-select: none; }
    :host(.dragging) .ds-card { transition: none; }

    .ds-card {
      width: 248px;
      box-sizing: border-box;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(31, 35, 41, 0.18);
      border: 1px solid #e8eaf0;
      overflow: hidden;
      transition: top .25s ease, right .25s ease, left .25s ease, border-color .2s ease;
      color: #1f2329;
    }
    :host(.alert) .ds-card {
      border-color: #f54a45;
      box-shadow: 0 8px 28px rgba(245, 74, 69, 0.28);
    }

    .ds-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      background: linear-gradient(135deg, #4d6bfe 0%, #3b55e0 100%);
      color: #fff;
    }
    :host(.floating) .ds-header { cursor: grab; }
    :host(.dragging) .ds-header { cursor: grabbing; }

    .ds-logo {
      width: 18px; height: 18px; border-radius: 5px;
      background: #fff; overflow: hidden;
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .ds-logo-img { width: 100%; height: 100%; display: block; }
    .ds-title { font-size: 12px; font-weight: 700; }
    .ds-spacer { flex: 1; }

    .ds-icon {
      width: 24px; height: 24px; border: none; border-radius: 6px;
      background: transparent; color: #fff; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 0;
    }
    .ds-icon:hover { background: rgba(255,255,255,.22); }
    .ds-icon.spinning svg { animation: ds-spin .9s linear infinite; }
    @keyframes ds-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

    .ds-body { padding: 10px 12px 9px; }

    .ds-alert {
      display: none;
      background: #fef0f0; color: #f54a45;
      font-size: 11px; font-weight: 600;
      border-radius: 7px; padding: 6px 8px; margin-bottom: 8px;
      line-height: 1.4;
    }
    :host(.alert) .ds-alert { display: block; }

    .ds-nokey, .ds-error {
      font-size: 11.5px; line-height: 1.6; color: #6b7280;
      background: #f5f6fa; border-radius: 8px; padding: 8px 10px;
    }
    .ds-error { color: #f54a45; background: #fef0f0; margin-top: 6px; }

    .ds-balance-label { font-size: 11px; color: #6b7280; }
    .ds-balance {
      font-size: 28px; font-weight: 700; line-height: 1.2;
      color: #1f2329; font-variant-numeric: tabular-nums;
    }
    .ds-balance .cur { font-size: 16px; color: #6b7280; margin-right: 1px; }
    :host(.alert) .ds-balance { color: #f54a45; }

    .ds-sub { font-size: 11px; color: #6b7280; margin-top: 2px; }

    .ds-usage {
      margin-top: 9px;
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    }
    .ds-chip { border-radius: 8px; padding: 6px 9px; }
    .ds-chip.hit { background: #ecf8f1; }
    .ds-chip.miss { background: #fff5ec; }
    .ds-chip .k { display: block; font-size: 10px; color: #6b7280; }
    .ds-chip.hit .v { color: #18a058; }
    .ds-chip.miss .v { color: #e07b16; }
    .ds-chip .v { display: block; font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }

    .ds-meta { margin-top: 7px; font-size: 10.5px; color: #6b7280; line-height: 1.5; }

    .ds-foot {
      margin-top: 8px; padding-top: 7px; border-top: 1px solid #f0f1f5;
      font-size: 10.5px; color: #9ca3af;
      display: flex; align-items: center; gap: 5px;
    }
    .ds-dot { width: 6px; height: 6px; border-radius: 50%; background: #9ca3af; flex-shrink: 0; }
    .ds-dot.ok { background: #18a058; }
    .ds-dot.error { background: #f54a45; }
    .ds-dot.loading { background: #f59e0b; animation: ds-pulse 1s ease-in-out infinite; }
    @keyframes ds-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  `;

  const TEMPLATE = `
    <div class="ds-card">
      <div class="ds-header" id="ds-header">
        <span class="ds-logo">
          <img class="ds-logo-img" alt="DeepSeek 图标">
        </span>
        <span class="ds-title">DeepSeek 余额</span>
        <span class="ds-spacer"></span>
        <button class="ds-icon" id="ds-refresh" title="立即刷新" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/>
          </svg>
        </button>
        <button class="ds-icon" id="ds-close" title="关闭浮窗（可在扩展设置中重新开启）" type="button">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path fill="currentColor" d="M18.3 5.71 12 12.01l-6.3-6.3-1.4 1.4 6.3 6.3-6.3 6.3 1.4 1.4 6.3-6.3 6.3 6.3 1.4-1.4-6.3-6.3 6.3-6.3z"/>
          </svg>
        </button>
      </div>
      <div class="ds-body">
        <div class="ds-alert" id="ds-alert"></div>
        <div class="ds-nokey" id="ds-nokey">未配置 API Key，请点击浏览器工具栏中的「DeepSeek 余额助手」图标完成配置</div>
        <div class="ds-main" id="ds-main" hidden>
          <div class="ds-balance-label">可用余额（元）</div>
          <div class="ds-balance"><span class="cur">¥</span><span id="ds-balance">--.--</span></div>
          <div class="ds-sub" id="ds-sub">已消耗 ¥0.00（本地统计）</div>
          <div class="ds-usage">
            <div class="ds-chip miss"><span class="k">缓存未命中</span><span class="v" id="ds-miss">0</span></div>
            <div class="ds-chip hit"><span class="k">缓存命中</span><span class="v" id="ds-hit">0</span></div>
          </div>
          <div class="ds-meta" id="ds-meta">命中率 -- · 总 tokens 0 · 请求 0 次（今日）</div>
        </div>
        <div class="ds-error" id="ds-error" hidden></div>
        <div class="ds-foot">
          <span class="ds-dot" id="ds-dot"></span>
          <span id="ds-foot-text">尚未查询</span>
        </div>
      </div>
    </div>
  `;

  let host = null;
  let $ = null;
  let ui = {};
  let dragging = false;
  let dragOffset = null;

  /* ----------------------------- 状态读取 ----------------------------- */

  async function loadState() {
    const stored = await chrome.storage.local.get(STORAGE_KEYS);
    state.settings = { ...DEFAULT_SETTINGS, ...(stored.ds_settings || {}) };
    state.data = stored.ds_last_data || null;
    state.error = stored.ds_last_error || null;
    state.usage = stored.ds_usage || null;
    state.key = stored.ds_api_key || '';
    state.pos = stored.ds_widget_pos || null;
  }

  /* ----------------------------- 模式与位置 ----------------------------- */

  function currentMode() {
    return state.settings.widgetMode || 'floating';
  }

  function applyMode() {
    const mode = currentMode();
    host.classList.toggle('floating', mode === 'floating');
    host.classList.toggle('pinned', mode === 'pinned');
    host.setAttribute('data-mode', mode);

    if (mode === 'pinned') {
      host.style.left = '';
      host.style.top = '';
      host.style.right = '';
    } else if (mode === 'floating') {
      if (state.pos && Number.isFinite(state.pos.x) && Number.isFinite(state.pos.y)) {
        host.style.right = 'auto';
        host.style.left = clamp(state.pos.x, 4, Math.max(4, window.innerWidth - 60)) + 'px';
        host.style.top = clamp(state.pos.y, 4, Math.max(4, window.innerHeight - 60)) + 'px';
      } else {
        host.style.left = '';
        host.style.top = '';
        host.style.right = '';
      }
    }
  }

  function savePos(x, y) {
    state.pos = { x, y };
    chrome.storage.local.set({ ds_widget_pos: { x, y } });
  }

  function bindDrag() {
    const header = $('#ds-header');

    header.addEventListener('pointerdown', (e) => {
      if (currentMode() !== 'floating') return;
      if (e.target.closest('button')) return;
      e.preventDefault();

      const rect = host.getBoundingClientRect();
      // 从 right 锚定切换为 left/top 锚定，便于跟随指针
      host.style.right = 'auto';
      host.style.left = rect.left + 'px';
      host.style.top = rect.top + 'px';

      dragging = true;
      dragOffset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      host.classList.add('dragging');
      try { header.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      const x = clamp(e.clientX - dragOffset.x, 4, window.innerWidth - w - 4);
      const y = clamp(e.clientY - dragOffset.y, 4, window.innerHeight - h - 4);
      host.style.left = x + 'px';
      host.style.top = y + 'px';
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      host.classList.remove('dragging');
      const rect = host.getBoundingClientRect();
      savePos(Math.round(rect.left), Math.round(rect.top));
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);

    // 窗口尺寸变化时把浮窗拉回可视区
    window.addEventListener('resize', () => {
      if (currentMode() !== 'floating' || !state.pos) return;
      const w = host.offsetWidth;
      const h = host.offsetHeight;
      const x = clamp(state.pos.x, 4, Math.max(4, window.innerWidth - w - 4));
      const y = clamp(state.pos.y, 4, Math.max(4, window.innerHeight - h - 4));
      host.style.left = x + 'px';
      host.style.top = y + 'px';
      if (x !== state.pos.x || y !== state.pos.y) savePos(x, y);
    });
  }

  /* ----------------------------- 渲染 ----------------------------- */

  function render() {
    host.classList.toggle('alert', !!state.data && shouldAlert(state.data.available, state.settings));

    // 无 Key 引导
    ui.nokey.hidden = !!state.key;
    ui.main.hidden = !state.key;

    if (state.key && state.data) {
      ui.balance.textContent = formatMoney(state.data.available);
      ui.sub.textContent = `已消耗 ¥${formatMoney(state.data.consumed || 0)}（本地统计）`;

      const today = state.usage && state.usage.today ? state.usage.today : null;
      const hit = today ? today.hit : 0;
      const miss = today ? today.miss : 0;
      const rate = hitRate(hit, miss);
      ui.hit.textContent = formatTokens(hit);
      ui.miss.textContent = formatTokens(miss);
      ui.meta.textContent = `命中率 ${rate === null ? '--' : rate.toFixed(1) + '%'} · 总 tokens ${formatTokens(today ? today.total : 0)} · 请求 ${today ? today.requests : 0} 次（今日）`;

      ui.alert.textContent = `余额不足：可用 ¥${formatMoney(state.data.available)}，已低于预警阈值 ¥${Number(state.settings.threshold).toFixed(2)}，请及时充值`;
    }

    // 错误信息（不覆盖上次成功数据）
    if (state.error && state.error.message) {
      ui.error.hidden = false;
      ui.error.textContent = state.error.message;
    } else {
      ui.error.hidden = true;
    }

    // 底部状态
    if (state.data && state.data.fetchedAt) {
      ui.dot.className = 'ds-dot ok';
      ui.footText.textContent = `上次更新 ${formatTime(state.data.fetchedAt)}`;
    } else if (state.error) {
      ui.dot.className = 'ds-dot error';
      ui.footText.textContent = '更新失败';
    } else {
      ui.dot.className = 'ds-dot';
      ui.footText.textContent = state.key ? '正在查询…' : '尚未查询';
    }
  }

  /* ----------------------------- 交互 ----------------------------- */

  function setLoading(loading) {
    ui.refresh.classList.toggle('spinning', loading);
    ui.refresh.disabled = loading;
    if (loading) {
      ui.dot.className = 'ds-dot loading';
      ui.footText.textContent = '正在查询最新余额…';
    }
  }

  async function manualRefresh() {
    if (ui.refresh.disabled) return;
    if (!state.key) return;
    setLoading(true);
    try {
      await chrome.runtime.sendMessage({ type: 'DS_REFRESH' });
    } catch (e) {
      /* storage 回写后会触发渲染，失败由状态点体现 */
    }
    setTimeout(() => setLoading(false), 1500);
  }

  async function closeWidget() {
    // 关闭即写入 off 模式，与设置面板中的选项保持一致
    const next = { ...state.settings, widgetMode: 'off' };
    await chrome.storage.local.set({ ds_settings: next });
  }

  /* ----------------------------- 启动 ----------------------------- */

  function buildDom() {
    host = document.createElement('div');
    host.id = 'ds-balance-widget';
    // open 模式：样式与 DOM 仍完全隔离在 Shadow DOM 内，open 仅便于调试与自动化验证
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const wrap = document.createElement('div');
    wrap.innerHTML = TEMPLATE.trim();
    shadow.appendChild(style);
    shadow.appendChild(wrap.firstChild);
    (document.body || document.documentElement).appendChild(host);

    ui = {
      nokey: shadow.getElementById('ds-nokey'),
      main: shadow.getElementById('ds-main'),
      balance: shadow.getElementById('ds-balance'),
      sub: shadow.getElementById('ds-sub'),
      hit: shadow.getElementById('ds-hit'),
      miss: shadow.getElementById('ds-miss'),
      meta: shadow.getElementById('ds-meta'),
      alert: shadow.getElementById('ds-alert'),
      error: shadow.getElementById('ds-error'),
      dot: shadow.getElementById('ds-dot'),
      footText: shadow.getElementById('ds-foot-text'),
      refresh: shadow.getElementById('ds-refresh'),
      close: shadow.getElementById('ds-close')
    };
    // 供拖拽等内部查询复用
    $ = (sel) => shadow.querySelector(sel);

    // 内容脚本中需用扩展绝对 URL 引用图标资源
    if (chrome.runtime && typeof chrome.runtime.getURL === 'function') {
      $('.ds-logo-img').src = chrome.runtime.getURL('icons/icon128.png');
    }

    ui.refresh.addEventListener('click', manualRefresh);
    ui.close.addEventListener('click', closeWidget);
    bindDrag();
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (changes.ds_settings) state.settings = { ...DEFAULT_SETTINGS, ...(changes.ds_settings.newValue || {}) };
    if (changes.ds_last_data) state.data = changes.ds_last_data.newValue || null;
    if (changes.ds_last_error) state.error = changes.ds_last_error.newValue || null;
    if (changes.ds_usage) state.usage = changes.ds_usage.newValue || null;
    if (changes.ds_api_key) state.key = changes.ds_api_key.newValue || '';
    if (changes.ds_widget_pos) state.pos = changes.ds_widget_pos.newValue || null;

    if (changes.ds_settings) applyMode();
    render();
  }

  async function boot() {
    buildDom();
    await loadState();
    applyMode();
    render();
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  // 测试钩子：Node vm 中 document 不存在时仅导出纯函数
  const pureApi = { formatMoney, formatTokens, formatTime, clamp, shouldAlert, hitRate, DEFAULT_SETTINGS };
  if (typeof globalThis.__dsWidgetTest === 'object' && globalThis.__dsWidgetTest !== null) {
    globalThis.__dsWidgetTest.api = pureApi;
  }

  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
      boot();
    }
  }
})();
