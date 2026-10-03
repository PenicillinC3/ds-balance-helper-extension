/**
 * ============================================================
 * platform-export.js - 平台页内容脚本（ISOLATED world）
 * ============================================================
 * 负责「用登录态自动拉取全平台用量」：
 *   1. 从页面 localStorage 读取登录令牌 userToken；
 *   2. 直接请求官方用量导出接口（GET，返回 ZIP）；
 *   3. 用 bill.js 解开 ZIP、归一化并聚合；
 *   4. 把聚合结果交回后台，由后台写入账单存储。
 *
 * 为什么必须放在页面里执行，而不是后台：
 *   - 令牌只存在于页面的 localStorage 中，后台读不到；
 *   - 该接口用 `Authorization: Bearer <userToken>` 鉴权，不接受 cookie，
 *     后台用自己的身份发这个请求拿不到数据。
 *
 * 隐私：令牌只在这一次请求中使用，不写入任何存储、不发给 DeepSeek 之外的
 * 任何地方；本脚本不读取页面内容，只读 localStorage 中的登录令牌。
 *
 * 注意：该接口是平台内部接口（非官方公开 API），官方改版可能使其失效；
 * 失效时请改用「手动导入」官方导出的压缩包。
 * ============================================================
 */

(function () {
  'use strict';

  if (window.__DS_PLATFORM_EXPORT_LOADED__) return;
  window.__DS_PLATFORM_EXPORT_LOADED__ = true;

  var EXPORT_URL = 'https://platform.deepseek.com/api/v0/usage/export';
  var USAGE_PAGE_URL = 'https://platform.deepseek.com/usage';
  var TOKEN_KEY = 'userToken';

  /** 读取页面登录态令牌（只读，不存储） */
  function readUserToken() {
    try {
      return DS_BILL.extractUserToken(window.localStorage.getItem(TOKEN_KEY));
    } catch (e) {
      return '';
    }
  }

  function buildExportUrl(range) {
    return EXPORT_URL +
      '?start=' + encodeURIComponent(range.start) +
      '&end=' + encodeURIComponent(range.end) +
      '&tz=' + encodeURIComponent(range.tz);
  }

  /** ZIP 本地文件头魔数：PK\x03\x04 */
  function looksLikeZip(buf) {
    if (!buf || buf.byteLength < 4) return false;
    var u8 = new Uint8Array(buf.slice(0, 4));
    return u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
  }

  /**
   * 拉取并解析一个月的用量导出包。
   * @param {{start: number, end: number, tz: number}} range
   * @returns {Promise<object>} 成功 {ok:true, month, agg, records, warnings}
   *                            失败 {ok:false, code, message, details?}
   */
  async function exportMonth(range) {
    var token = readUserToken();
    if (!token) {
      return {
        ok: false,
        code: 'NO_TOKEN',
        message: '没有找到平台登录态，请先登录并打开 ' + USAGE_PAGE_URL + '（刷新该页面）后再点自动拉取'
      };
    }

    var url = buildExportUrl(range);
    var resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/json, application/zip, */*',
          'x-client-platform': 'web'
        }
      });
    } catch (e) {
      return {
        ok: false,
        code: 'NETWORK',
        message: '请求用量导出接口失败，请检查网络后重试',
        details: ['GET ' + url.replace(/\?.*$/, '') + '：网络异常']
      };
    }

    if (resp.status === 401 || resp.status === 403) {
      return {
        ok: false,
        code: 'AUTH',
        message: '登录态已失效，请重新登录并打开 ' + USAGE_PAGE_URL + '（刷新该页面）后再点自动拉取',
        details: ['用量导出接口返回 HTTP ' + resp.status]
      };
    }

    if (!resp.ok) {
      return {
        ok: false,
        code: 'HTTP_' + resp.status,
        message: '用量导出接口返回异常（HTTP ' + resp.status + '），请稍后重试或改用手动导入',
        details: ['GET ' + url.replace(/\?.*$/, '') + '：HTTP ' + resp.status]
      };
    }

    var buf;
    try {
      buf = await resp.arrayBuffer();
    } catch (e) {
      return { ok: false, code: 'READ_FAIL', message: '读取导出数据失败，请重试' };
    }

    // 未登录时接口可能返回登录页 HTML（HTTP 200），按魔数兜住
    if (!looksLikeZip(buf)) {
      return {
        ok: false,
        code: 'NOT_ZIP',
        message: '接口没有返回用量压缩包（可能登录态已失效），请重新登录后重试',
        details: ['响应不是 ZIP（前 4 字节不是 PK\\x03\\x04）']
      };
    }

    var entries;
    try {
      entries = await DS_BILL.parseZip(buf);
    } catch (e) {
      return {
        ok: false,
        code: 'BAD_ZIP',
        message: '解析用量压缩包失败：' + (e && e.message ? e.message : e)
      };
    }

    if (!entries.length) {
      return { ok: false, code: 'EMPTY_ZIP', message: '用量压缩包里没有找到 CSV 明细' };
    }

    var parsed = DS_BILL.parseTexts(entries);
    if (!parsed.records.length) {
      return {
        ok: false,
        code: 'NO_RECORDS',
        message: '压缩包里没有解析出任何用量记录，可能该月没有调用记录',
        details: parsed.warnings
      };
    }

    // 按月分别归档：请求的是单月窗口，但接口可能多返回几天跨月数据
    return {
      ok: true,
      month: parsed.month ||
        DS_BILL.monthOfTime(new Date(range.start * 1000).toISOString()) ||
        'unknown',
      months: DS_BILL.aggregateByMonth(parsed.records),
      records: parsed.records.length,
      warnings: parsed.warnings
    };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'DS_PLATFORM_EXPORT') return false;

    var range = message.range || DS_BILL.usageExportRange(message.month);
    exportMonth(range)
      .then(sendResponse)
      .catch(function (e) {
        sendResponse({ ok: false, code: 'UNKNOWN', message: '自动拉取失败：' + (e && e.message ? e.message : e) });
      });
    return true; // 异步 sendResponse
  });
})();
