/**
 * ============================================================
 * interceptor-bridge.js - 隔离世界（ISOLATED world）桥接脚本
 * ============================================================
 * MAIN world 的 interceptor-main.js 无法访问 chrome.runtime，
 * 由本脚本监听 window.postMessage 并转发给后台 service worker 汇总。
 */

(function () {
  'use strict';

  if (window.__DS_USAGE_BRIDGE_PATCHED__) return;
  window.__DS_USAGE_BRIDGE_PATCHED__ = true;

  window.addEventListener('message', function (event) {
    // 只接受本窗口的消息
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data.__dsUsage !== true || !data.payload) return;

    try {
      chrome.runtime.sendMessage({ type: 'DS_USAGE_RECORD', record: data.payload }, function () {
        // 读取并丢弃 lastError，例如 SW 未就绪时避免控制台报错
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* 扩展上下文失效等情况下静默 */
    }
  });
})();
