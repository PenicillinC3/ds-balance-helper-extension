/**
 * ============================================================
 * 测试辅助：在 Node vm 里加载扩展脚本，并伪造 chrome API / window。
 * ============================================================
 * 只做"运行环境替身"，不替身被测逻辑本身：
 *   - createBackgroundEnv()     加载真实的 background.js + bill.js
 *   - createPlatformExportEnv() 加载真实的 bill.js + platform-export.js
 *   - createWidgetEnv()         加载真实的 widget.js（仅取其中的纯函数）
 * 各自返回可断言的存储 / 消息 / 调用记录。
 * ============================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

function readSource(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 按 chrome.storage 的语义挑出要返回的键（支持 string / array / null） */
function pickKeys(store, keys) {
  if (keys == null) return deepClone(store);
  if (typeof keys === 'string') {
    return keys in store ? { [keys]: deepClone(store[keys]) } : {};
  }
  const out = {};
  (Array.isArray(keys) ? keys : Object.keys(keys)).forEach((k) => {
    if (k in store) out[k] = deepClone(store[k]);
  });
  return out;
}

/**
 * 伪造 chrome.storage.local。
 *
 * @param {object} options.initial 初始存储内容
 * @param {number} options.delay 每次读写的延迟（毫秒），用于让异步交错有机会发生
 * @param {{key: string, count: number, timeoutMs?: number}} [options.holdReads]
 *   读屏障：前 count 次「包含该键的读」会被扣住，凑齐 count 次后一起放行，
 *   从而确定性地复现「两个并发调用读到同一份旧快照，然后互相覆盖」，
 *   而不是靠计时碰运气。
 *
 *   必须带超时兜底：修好竞态后第二次读要等第一个任务写完才会发生，
 *   只等 count 次会直接死锁。超时（默认 50ms）到点即放行，
 *   于是「未修复」时两次读凑在同一窗口内 → 复现覆盖；
 *   「已修复」时第一次读超时放行、任务结束，第二次读再来拿到的是新值。
 */
function createStorage(options = {}) {
  const store = deepClone(options.initial) || {};
  const delay = options.delay == null ? 1 : options.delay;
  const hold = options.holdReads
    ? {
      key: options.holdReads.key,
      count: options.holdReads.count,
      timeoutMs: options.holdReads.timeoutMs == null ? 50 : options.holdReads.timeoutMs,
      held: [],
      timer: null,
      done: false,
    }
    : null;

  function includesHoldKey(keys) {
    if (!hold) return false;
    if (keys == null) return true;
    if (typeof keys === 'string') return keys === hold.key;
    return (Array.isArray(keys) ? keys : Object.keys(keys)).includes(hold.key);
  }

  function releaseHeld() {
    if (hold.timer) {
      clearTimeout(hold.timer);
      hold.timer = null;
    }
    hold.done = true;
    const pending = hold.held.slice();
    hold.held.length = 0;
    pending.forEach((release) => release());
  }

  return {
    store,
    api: {
      get(keys, cb) {
        setTimeout(() => {
          const snapshot = pickKeys(store, keys); // 关键：快照在"读"的当下生成
          if (hold && !hold.done && includesHoldKey(keys) && hold.held.length < hold.count) {
            hold.held.push(() => cb(snapshot));
            if (hold.held.length === hold.count) releaseHeld();
            else if (!hold.timer) hold.timer = setTimeout(releaseHeld, hold.timeoutMs);
            return;
          }
          cb(snapshot);
        }, delay);
      },
      set(obj, cb) {
        setTimeout(() => {
          Object.entries(obj || {}).forEach(([k, v]) => {
            if (v === null || v === undefined) delete store[k];
            else store[k] = deepClone(v);
          });
          if (typeof cb === 'function') cb();
        }, delay);
      },
    },
  };
}

/**
 * 加载 background.js（含 importScripts('bill.js')）到 vm 中。
 * @returns {{sandbox, storage, fetchCalls, balanceQueue}}
 */
function createBackgroundEnv(options = {}) {
  const storage = createStorage(options);
  const fetchCalls = [];
  const balanceQueue = []; // 依次作为每次余额接口的返回值
  const messageHandlers = [];
  const sendMessageCalls = []; // 后台向内容脚本发出的消息
  const executeScriptCalls = []; // 后台现场注入内容脚本的记录

  const noop = () => {};
  const chrome = {
    storage: {
      local: storage.api,
      onChanged: { addListener: noop },
    },
    runtime: {
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      onMessage: { addListener: (fn) => messageHandlers.push(fn) },
      getManifest: () => ({ version: options.version || '9.9.9-test' }),
    },
    alarms: { create: noop, clear: async () => {}, onAlarm: { addListener: noop } },
    notifications: {
      create: (id, opts, cb) => { if (cb) cb(); },
      clear: async () => {},
      onClicked: { addListener: noop },
    },
    scripting: {
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
      // 现场注入内容脚本（用于"唤不醒就注入"的兜底路径）
      executeScript: async (opts) => {
        executeScriptCalls.push(opts);
        if (options.onExecuteScript) return options.onExecuteScript(opts);
        return [{ result: null }];
      },
    },
    action: { openPopup: async () => {} },
    tabs: {
      create: async () => {},
      query: async () => options.tabs || [],
      sendMessage: async (tabId, message) => {
        sendMessageCalls.push({ tabId, message });
        // 抛异常用于模拟"内容脚本已失效 / 接收端不存在"
        if (options.onSendMessage) return options.onSendMessage(tabId, message);
        return { ok: false, message: 'no content script' };
      },
    },
  };

  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    // 这些是宿主提供的 Web 全局对象，vm 的新 context 里没有，必须显式注入
    AbortController,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    Blob,
    Response,
    DecompressionStream,
    chrome,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      const next = balanceQueue.length ? balanceQueue.shift() : { available: 100 };
      if (next && next.__networkError) throw new Error('network down');
      return {
        status: next.status || 200,
        ok: (next.status || 200) === 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          is_available: true,
          balance_infos: [{
            currency: 'CNY',
            total_balance: String(next.available),
            topped_up_balance: String(next.toppedUp == null ? 0 : next.toppedUp),
            granted_balance: String(next.granted == null ? 0 : next.granted),
          }],
        }),
        text: async () => '{}',
      };
    },
    importScripts: (file) => {
      vm.runInContext(readSource(file), sandbox, { filename: file });
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(readSource('background.js'), sandbox, { filename: 'background.js' });

  return {
    sandbox,
    storage,
    fetchCalls,
    balanceQueue,
    messageHandlers,
    sendMessageCalls,
    executeScriptCalls,
  };
}

/**
 * 加载 widget.js 到 vm 中，只取其中的纯函数（不构建 Shadow DOM）。
 *
 * widget.js 是内容脚本，顶层会做「仅顶层框架」判断并在有 document 时启动，
 * 因此这里不提供 document / chrome：脚本走到最后只会把纯函数挂到
 * globalThis.__dsWidgetTest.api 上。
 * @returns {{sandbox, api}}
 */
function createWidgetEnv() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.top = sandbox; // window.top === window，通过「仅顶层框架」判断
  sandbox.__dsWidgetTest = {};

  vm.createContext(sandbox);
  vm.runInContext(readSource('widget.js'), sandbox, { filename: 'widget.js' });

  return { sandbox, api: sandbox.__dsWidgetTest.api };
}

/**
 * 加载平台页内容脚本（bill.js + platform-export.js）到 vm 中。
 * 提供可配置的 localStorage 与页面 fetch，用于验证「登录态自动拉取」。
 * @param {object} options.localStorage 初始 localStorage 内容
 */
function createPlatformExportEnv(options = {}) {
  const store = { ...(options.localStorage || {}) };
  const fetchCalls = [];
  const impl = { fn: async () => { throw new Error('页面 fetch 未被桩替换'); } };
  const messageHandlers = [];

  const noop = () => {};
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => messageHandlers.push(fn) },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    storage: { local: { get: noop, set: noop }, onChanged: { addListener: noop } },
  };

  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    TextDecoder,
    TextEncoder,
    Blob,
    Response,
    DecompressionStream,
    chrome,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return impl.fn(url, init);
    },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = { href: 'https://platform.deepseek.com/usage' };

  vm.createContext(sandbox);
  vm.runInContext(readSource('bill.js'), sandbox, { filename: 'bill.js' });
  vm.runInContext(readSource('platform-export.js'), sandbox, { filename: 'platform-export.js' });

  return {
    sandbox,
    store,
    fetchCalls,
    messageHandlers,
    /** 让下一次（及之后）的 fetch 返回指定响应 */
    respondWith(fn) { impl.fn = fn; },
    /** 触发内容脚本的消息处理，返回其响应（支持异步 sendResponse） */
    sendMessage(message) {
      return new Promise((resolve, reject) => {
        let answered = false;
        messageHandlers.forEach((handler) => {
          handler(message, { id: 'test' }, (resp) => {
            if (!answered) { answered = true; resolve(resp); }
          });
        });
        setTimeout(() => { if (!answered) reject(new Error('内容脚本没有响应消息')); }, 900);
      });
    },
  };
}

module.exports = {
  ROOT,
  readSource,
  createStorage,
  createBackgroundEnv,
  createPlatformExportEnv,
  createWidgetEnv,
};
