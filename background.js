/**
 * ============================================================
 * DeepSeek 余额助手 - 后台 Service Worker（Manifest V3）
 * ============================================================
 * 职责：
 *   1. 安装时初始化默认配置；
 *   2. 通过 chrome.alarms 定时调用余额接口（无需打开弹窗）；
 *   3. 低余额时通过 chrome.notifications 弹出系统通知；
 *   4. 同一“低余额状态”24 小时内只提醒一次（防骚扰）；
 *   5. 响应弹窗的手动刷新请求；
 *   6. 本地累计统计两次刷新之间检测到的消耗金额。
 *
 * 说明：DeepSeek 官方 GET /user/balance 仅返回当前余额
 * （总余额 / 充值余额 / 赠送余额），不返回历史已用金额与总额度，
 * 因此“已消耗”为本地根据余额下降差值累计的估算值。
 * ============================================================
 */

const API_URL = 'https://api.deepseek.com/user/balance';
const ALARM_NAME = 'ds-balance-refresh';
const NOTIFICATION_ID = 'ds-low-balance';
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 防重复提醒窗口：24 小时
const REQUEST_TIMEOUT_MS = 15000;              // 单次请求超时：15 秒

// 安装时写入的默认配置
const DEFAULT_SETTINGS = {
  threshold: 5,        // 低余额预警阈值（元）
  alertsEnabled: true, // 是否开启余额提醒
  refreshInterval: 10, // 自动刷新间隔（分钟）：5 / 10 / 30 / 60
  widgetMode: 'floating' // 页面浮窗：floating 可拖拽悬浮 / pinned 右上角常驻 / off 不显示
};

/* -------------------------- 存储工具函数 -------------------------- */

function getLocal(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setLocal(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function getSettings() {
  const { ds_settings: stored } = await getLocal('ds_settings');
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

async function getApiKey() {
  const { ds_api_key: key } = await getLocal('ds_api_key');
  return (key || '').trim();
}

/* -------------------------- 定时任务管理 -------------------------- */

/**
 * 根据“是否已保存 API Key + 刷新间隔”重建闹钟。
 * 没有 Key 时不启动后台轮询，避免无意义请求。
 */
async function setupAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const key = await getApiKey();
  if (!key) return;

  const settings = await getSettings();
  const period = Number(settings.refreshInterval) || DEFAULT_SETTINGS.refreshInterval;

  // delayInMinutes：浏览器启动 / 配置变更后 1 分钟先查一次，之后按周期执行
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: period,
    delayInMinutes: 1
  });
}

/* -------------------------- 余额接口查询 -------------------------- */

/**
 * 调用 DeepSeek 官方余额接口，并对各类异常给出标准化错误。
 * @returns {Promise<{ok: true, data: object} | {ok: false, error: string, message: string}>}
 */
async function fetchBalance() {
  const key = await getApiKey();
  if (!key) {
    return { ok: false, error: 'NO_KEY', message: '请先配置 API Key' };
  }

  let resp;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    resp = await fetch(API_URL, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
  } catch (err) {
    // 网络断开、DNS 失败、超时（AbortError）等均归为网络异常
    return {
      ok: false,
      error: 'NETWORK',
      message: '网络异常，无法连接 DeepSeek 服务，请检查网络后重试'
    };
  }

  // ---- HTTP 状态码分级处理 ----
  if (resp.status === 401) {
    return { ok: false, error: 'AUTH', message: 'API Key 无效或已失效，请检查后重新输入' };
  }
  if (resp.status === 402) {
    return { ok: false, error: 'PAYMENT', message: '账户状态异常（HTTP 402），请登录 DeepSeek 平台查看' };
  }
  if (resp.status === 429) {
    return { ok: false, error: 'RATE_LIMIT', message: '请求过于频繁，已触发接口限流，请稍后再试' };
  }
  if (!resp.ok) {
    return { ok: false, error: `HTTP_${resp.status}`, message: `接口返回异常（HTTP ${resp.status}），请稍后重试` };
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    return { ok: false, error: 'BAD_JSON', message: '接口返回数据格式异常，无法解析，请稍后重试' };
  }

  // 官方返回结构：{ is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
  const list = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const info = list.find((x) => x && x.currency === 'CNY') || list[0];
  if (!info || info.total_balance === undefined || info.total_balance === null) {
    return { ok: false, error: 'BAD_DATA', message: '接口返回数据缺少余额字段（balance_infos）' };
  }

  const available = parseFloat(info.total_balance);
  const toppedUp = parseFloat(info.topped_up_balance);
  const granted = parseFloat(info.granted_balance);
  if (Number.isNaN(available)) {
    return { ok: false, error: 'BAD_DATA', message: '接口返回的余额数值无法识别' };
  }

  return {
    ok: true,
    data: {
      isAvailable: body.is_available !== false,
      currency: info.currency || 'CNY',
      available,                        // 可用余额（总余额）
      toppedUp: Number.isNaN(toppedUp) ? null : toppedUp, // 充值余额
      granted: Number.isNaN(granted) ? null : granted,    // 赠送余额
      raw: body                         // 保留原始返回，便于后续扩展（如总额度字段）
    }
  };
}

/* -------------------------- 刷新主流程 -------------------------- */

/**
 * 查询一次余额并写入本地存储；成功时执行低余额判断。
 * @param {{manual?: boolean}} opts manual=true 表示用户在弹窗中手动触发
 */
async function refreshAndStore(opts = {}) {
  const fetchedAt = Date.now();
  const result = await fetchBalance();

  if (!result.ok) {
    // 失败不覆盖上一次成功数据，仅记录错误状态
    await setLocal({
      ds_last_error: {
        error: result.error,
        message: result.message,
        fetchedAt,
        manual: !!opts.manual
      }
    });
    return result;
  }

  const d = result.data;

  // ---- 本地累计消耗统计：本次可用余额较上次下降的差值视为消耗 ----
  const { ds_prev_balance: prev, ds_consumed: consumedSoFar } =
    await getLocal(['ds_prev_balance', 'ds_consumed']);
  let consumed = Number(consumedSoFar) || 0;
  if (typeof prev === 'number' && d.available < prev) {
    consumed += prev - d.available;
  }
  consumed = Math.round(consumed * 10000) / 10000; // 保留 4 位小数，避免浮点误差

  // 若官方未来返回总额度字段，可在此扩展（totalQuota）
  const totalQuota =
    d.raw && typeof d.raw.total_quota !== 'undefined' ? Number(d.raw.total_quota) : null;

  const data = {
    isAvailable: d.isAvailable,
    currency: d.currency,
    available: d.available,
    toppedUp: d.toppedUp,
    granted: d.granted,
    totalQuota: Number.isFinite(totalQuota) ? totalQuota : null,
    consumed,
    fetchedAt
  };

  await setLocal({
    ds_last_data: data,
    ds_prev_balance: d.available,
    ds_consumed: consumed,
    ds_last_error: null // 查询成功，清除历史错误
  });

  await maybeAlert(d.available);
  return { ok: true, data };
}

/* -------------------------- 低余额提醒 -------------------------- */

/**
 * 判断是否需要弹出低余额通知。
 * 防重复规则：进入“低余额状态”时提醒一次；只要一直处于该状态，
 * 24 小时内不再提醒；余额恢复到阈值以上（状态转为正常）后重置，
 * 再次跌破时可立即提醒。
 */
async function maybeAlert(balance) {
  const settings = await getSettings();
  const { ds_alert: alertState = {} } = await getLocal('ds_alert');
  const threshold = Number(settings.threshold);

  const isLow = Number.isFinite(threshold) && balance <= threshold;

  if (!settings.alertsEnabled || !isLow) {
    // 状态恢复正常：重置为 ok，下一次跌破可重新提醒
    if (alertState.state === 'low') {
      await setLocal({ ds_alert: { ...alertState, state: 'ok' } });
    }
    return;
  }

  const now = Date.now();
  if (
    alertState.state === 'low' &&
    alertState.lastAlertAt &&
    now - alertState.lastAlertAt < ALERT_COOLDOWN_MS
  ) {
    // 同一低余额状态 24 小时内已提醒过，跳过
    return;
  }

  await showLowBalanceNotification(balance, threshold);
  await setLocal({ ds_alert: { state: 'low', lastAlertAt: now } });
}

function showLowBalanceNotification(balance, threshold) {
  return new Promise((resolve) => {
    chrome.notifications.create(
      NOTIFICATION_ID,
      {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'DeepSeek 余额预警',
        message: `可用余额仅剩 ¥${balance.toFixed(2)}，已低于预警阈值 ¥${Number(threshold).toFixed(2)}，请及时充值。`,
        priority: 2,
        requireInteraction: false
      },
      () => resolve()
    );
  });
}

/**
 * 点击通知：优先直接打开扩展弹窗（Chrome 127+ / 新版 Edge 支持），
 * 不支持时退化为在新标签页打开 popup 页面。
 */
async function openPopupFromNotification() {
  try {
    if (typeof chrome.action.openPopup === 'function') {
      await chrome.action.openPopup();
      return;
    }
  } catch (err) {
    // 当前浏览器版本不允许在该上下文打开弹窗，走降级方案
  }
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  } catch (err) {
    /* 忽略：极端情况下 tabs 不可用时静默 */
  }
}

/* ---------------------- Token 用量统计（浏览器拦截） ---------------------- */

function emptyBucket(date) {
  return {
    date: date || null,
    requests: 0,
    prompt: 0,
    completion: 0,
    total: 0,
    hit: 0,
    miss: 0
  };
}

function emptyUsage() {
  return {
    total: emptyBucket(),
    today: emptyBucket(localDate()),
    models: {},
    lastRequestAt: null
  };
}

function localDate(d) {
  const dt = d || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

function addBucket(bucket, rec) {
  bucket.requests += 1;
  bucket.prompt += rec.prompt || 0;
  bucket.completion += rec.completion || 0;
  bucket.total += rec.total || 0;
  bucket.hit += rec.hit || 0;
  bucket.miss += rec.miss || 0;
}

/**
 * 接收内容脚本拦截到的单条 usage 并汇总：
 * total（累计）、today（按本地日期滚动）、models（按模型分组）。
 */
async function recordUsage(rec) {
  if (!rec || typeof rec !== 'object') return;
  // 基本合法性校验，丢弃脏数据
  ['prompt', 'completion', 'total', 'hit', 'miss'].forEach((k) => {
    if (!Number.isFinite(Number(rec[k]))) rec[k] = 0;
  });
  if (!rec.total && !rec.prompt && !rec.completion) return;

  const { ds_usage: stored } = await getLocal('ds_usage');
  const usage = stored && stored.total ? stored : emptyUsage();
  if (!usage.models) usage.models = {};

  addBucket(usage.total, rec);

  const today = localDate();
  if (!usage.today || usage.today.date !== today) {
    usage.today = emptyBucket(today); // 跨天自动重置今日统计
  }
  addBucket(usage.today, rec);

  if (rec.model) {
    if (!usage.models[rec.model]) usage.models[rec.model] = emptyBucket();
    addBucket(usage.models[rec.model], rec);
  }

  usage.lastRequestAt = rec.ts || Date.now();
  await setLocal({ ds_usage: usage });
}

/**
 * 根据用户在弹窗中添加的监控站点（ds_sites，origin 数组），
 * 动态注册 MAIN world 拦截器 + bridge（用于 token 用量采集）。
 * 官方平台 platform.deepseek.com 已在 manifest 中静态注册；
 * 页面浮窗 widget.js 已通过 <all_urls> 静态注入所有页面，无需动态注册。
 */
async function setupDynamicMonitors() {
  const ids = ['ds-monitor-main', 'ds-monitor-bridge'];
  try {
    await chrome.scripting.unregisterContentScripts({ ids });
  } catch (e) { /* 尚未注册时忽略 */ }

  const { ds_sites: sites = [] } = await getLocal('ds_sites');
  const matches = (sites || [])
    .map((s) => String(s).trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .map((origin) => origin + '/*');

  if (!matches.length) return;

  await chrome.scripting.registerContentScripts([
    {
      id: 'ds-monitor-main',
      matches,
      js: ['interceptor-main.js'],
      world: 'MAIN',
      runAt: 'document_start',
      allFrames: true
    },
    {
      id: 'ds-monitor-bridge',
      matches,
      js: ['interceptor-bridge.js'],
      runAt: 'document_start',
      allFrames: true
    }
  ]);
}

/* -------------------------- 事件注册 -------------------------- */

// 安装 / 更新：初始化默认配置并启动闹钟
chrome.runtime.onInstalled.addListener(async (details) => {
  const { ds_settings: stored } = await getLocal('ds_settings');
  if (!stored) {
    await setLocal({ ds_settings: DEFAULT_SETTINGS });
  }
  await setupAlarm();
  await setupDynamicMonitors();
  // 首次安装且此前已导入过 Key（如同步重装）时立即查一次
  if (details.reason === 'install' && (await getApiKey())) {
    refreshAndStore();
  }
});

// 浏览器启动：重建闹钟
chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

// 闹钟触发：后台定时刷新
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    refreshAndStore();
  }
});

// 消息分发：手动刷新 / 内容脚本上报 token 用量
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'DS_REFRESH') {
    refreshAndStore({ manual: true }).then(sendResponse);
    return true; // 异步 sendResponse，必须返回 true 保持消息通道
  }
  if (message && message.type === 'DS_USAGE_RECORD' && message.record) {
    recordUsage(message.record)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, message: String(e) }));
    return true;
  }
  return false;
});

// Key / 设置变化：重建闹钟（间隔修改立即生效）；监控站点变化：重注册内容脚本
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ds_api_key || changes.ds_settings) {
    setupAlarm();
  }
  if (changes.ds_sites) {
    setupDynamicMonitors();
  }
});

// 点击通知打开弹窗
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === NOTIFICATION_ID) {
    await chrome.notifications.clear(notificationId);
    await openPopupFromNotification();
  }
});
