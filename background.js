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

// 全平台账单解析（官方导出 CSV 归一化与聚合），与 popup、平台页共用同一套纯逻辑
importScripts('bill.js');

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

/* -------------------------- 写操作串行化 -------------------------- */

/**
 * chrome.storage 的「读 → 改 → 写」不是原子操作：两个并发调用会读到同一份
 * 旧快照，后写的结果把先写的整个覆盖掉。真实后果：定时刷新与手动刷新并发、
 * 或期间发生充值/扣费时，已累计的消耗金额会被覆盖（消耗少记）。
 * Service Worker 是单线程的，因此把所有写操作挂到同一条 Promise 链上排队即可。
 * @param {() => Promise<any>} task
 */
let writeChain = Promise.resolve();

function serializeWrite(task) {
  const run = writeChain.then(task, task);
  // 单个任务失败不能阻断后续任务：这里把结果与异常都吞掉再续链
  writeChain = run.then(() => {}, () => {});
  return run;
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
  // 读-改-写必须排队：并发刷新（定时任务 + 手动刷新 + 充值）时，
  // 后写的结果会覆盖前一次已记下的下降值，导致消耗少记。
  return serializeWrite(async () => {
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

    // 低余额状态判断同样是对 ds_alert 的读-改-写，一并放进队列，避免重复提醒
    await maybeAlert(d.available);
    return { ok: true, data };
  });
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

/* ------------------ 全平台账单：登录态自动拉取 ------------------ */

const PLATFORM_URL = 'https://platform.deepseek.com';
const USAGE_PAGE_URL = PLATFORM_URL + '/usage';
// 与 manifest 里注册的内容脚本保持一致
const PLATFORM_CONTENT_SCRIPTS = ['bill.js', 'platform-export.js'];

/** 把异常整理成一行可读文本，便于展示给用户 */
function describeError(e) {
  if (!e) return '未知错误';
  if (e.message) return e.message;
  return String(e);
}

/**
 * 从匹配到的平台标签页里挑一个最合适的：
 * 优先「用量信息」页（/usage），其次未被浏览器冻结丢弃的，最后是当前活动页。
 */
function pickPlatformTab(tabs) {
  const score = (tab) => {
    let s = 0;
    try {
      const path = new URL(tab.url || '').pathname.replace(/\/+$/, '');
      if (path === '/usage') s += 100;
    } catch (e) { /* URL 解析失败则不加分 */ }
    if (!tab.discarded) s += 10;
    if (tab.active) s += 1;
    return s;
  };
  return tabs.slice().sort((a, b) => score(b) - score(a))[0];
}

/**
 * 往标签页里现场注入内容脚本。
 *
 * 场景：扩展被重载后，**已经打开的页面**里的内容脚本会失效（旧扩展实例的
 * 上下文被销毁），页面看着正常但再也唤不醒，`tabs.sendMessage` 会抛
 * "Receiving end does not exist"。此时注入一份新的即可，无需用户手动刷新。
 *
 * 注入前先清掉"已注册"标记：能走到这里就说明原来的监听器已经失效
 * （否则上一步 sendMessage 就成功了），必须允许重新注册。
 */
async function injectPlatformScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try { delete window.__DS_PLATFORM_EXPORT_LOADED__; } catch (e) { /* 忽略 */ }
    }
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: PLATFORM_CONTENT_SCRIPTS
  });
}

/**
 * 用平台页面的登录态拉取全平台用量，并写入账单存储。
 *
 * 为什么后台不自己发这个请求：官方用量导出接口用
 * `Authorization: Bearer <userToken>` 鉴权（不接受 cookie），而该令牌只存在
 * 于平台页面的 localStorage 中，后台读不到。因此后台只负责找到平台标签页、
 * 把任务转交给页面里的 platform-export.js，再把结果入库。
 *
 * @param {string} [month] 'YYYY-MM'，缺省按当前月
 * @returns {Promise<{ok: true, month: string, records: number}
 *                  | {ok: false, code: string, message: string, details?: string[]}>}
 */
async function fetchBillFromPlatform(month) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: PLATFORM_URL + '/*' });
  } catch (e) {
    tabs = [];
  }

  if (!tabs || !tabs.length) {
    return {
      ok: false,
      code: 'NO_TAB',
      message: '请先在浏览器里打开并登录 ' + USAGE_PAGE_URL + '，再点自动拉取'
    };
  }

  const tab = pickPlatformTab(tabs);
  const range = DS_BILL.usageExportRange(month);
  const request = { type: 'DS_PLATFORM_EXPORT', range };
  const details = [];

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tab.id, request);
  } catch (e) {
    // 内容脚本失效（典型：重载扩展后没刷新过的页面）→ 现场注入再试一次
    details.push('首次通信失败：' + describeError(e));
    try {
      await injectPlatformScripts(tab.id);
      details.push('已重新注入内容脚本并重试');
      resp = await chrome.tabs.sendMessage(tab.id, request);
    } catch (e2) {
      details.push('注入后仍失败：' + describeError(e2));
      details.push('目标标签页：' + (tab.url || ('#' + tab.id)));
      return {
        ok: false,
        code: 'NO_CONTENT',
        message: '无法在平台页面内执行拉取，请刷新 ' + USAGE_PAGE_URL + ' 后重试',
        details: details
      };
    }
  }

  if (!resp || !resp.ok) {
    return {
      ok: false,
      code: (resp && resp.code) || 'FAIL',
      message: (resp && resp.message) || '自动拉取失败，请稍后重试或改用手动导入',
      details: (resp && resp.details) || null
    };
  }

  const { ds_bill_imports: stored } = await getLocal('ds_bill_imports');
  const imports = stored && typeof stored === 'object' ? stored : {};
  const warnings = Array.isArray(resp.warnings) ? resp.warnings : [];
  const importedAt = Date.now();

  // 按月分别归档（接口返回的数据可能跨月）
  const next = { ...imports };
  const months = resp.months && typeof resp.months === 'object'
    ? resp.months
    : { [resp.month || 'unknown']: { agg: resp.agg, records: resp.records || 0 } };

  Object.keys(months).forEach((month) => {
    next[month] = {
      agg: months[month].agg,
      source: 'auto',
      importedAt: importedAt,
      warnings: warnings
    };
  });

  await setLocal({ ds_bill_imports: next });

  return {
    ok: true,
    month: resp.month || Object.keys(months)[0] || 'unknown',
    months: Object.keys(months),
    records: resp.records || 0
  };
}

/* -------------------------- 事件注册 -------------------------- */

// 安装 / 更新：初始化默认配置并启动闹钟
chrome.runtime.onInstalled.addListener(async (details) => {
  const { ds_settings: stored } = await getLocal('ds_settings');
  if (!stored) {
    await setLocal({ ds_settings: DEFAULT_SETTINGS });
  }
  await setupAlarm();
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

// 消息分发：手动刷新余额 / 自动拉取账单 / 存活探测
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'DS_PING') {
    // 供弹窗判断后台是否为同一版本：扩展重载后，已打开页面的脚本会失效，
    // 弹窗探测不到响应时即可提示用户重新加载扩展。
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (message && message.type === 'DS_REFRESH') {
    refreshAndStore({ manual: true }).then(sendResponse);
    return true; // 异步 sendResponse，必须返回 true 保持消息通道
  }
  if (message && message.type === 'DS_BILL_FETCH') {
    fetchBillFromPlatform(message.month)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, message: String(e) }));
    return true;
  }
  return false;
});

// Key / 设置变化：重建闹钟（间隔修改立即生效）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.ds_api_key || changes.ds_settings) {
    setupAlarm();
  }
});

// 点击通知打开弹窗
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === NOTIFICATION_ID) {
    await chrome.notifications.clear(notificationId);
    await openPopupFromNotification();
  }
});
