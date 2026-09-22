/**
 * ============================================================
 * interceptor-main.js - 页面主世界（MAIN world）注入脚本
 * ============================================================
 * 在 document_start 时包装页面的 window.fetch / XMLHttpRequest，
 * 捕获发往 DeepSeek 的对话类接口响应中的 usage（token 用量），
 * 归一化后通过 window.postMessage 交给 interceptor-bridge.js 转发后台。
 *
 * 可识别的接口形态：
 *   - OpenAI 兼容：/chat/completions、/completions（含 FIM）
 *   - Responses API：/responses
 *   - Anthropic 兼容：/anthropic/messages
 *   - 普通 JSON 响应与 SSE 流式响应（data: {...}）均可
 *
 * 仅在内存中读取响应副本用于提取 usage，不修改任何请求/响应内容。
 */

(function () {
  'use strict';

  // 防止重复注入（all_frames / 动态注册场景）
  if (window.__DS_USAGE_PATCHED__) return;
  window.__DS_USAGE_PATCHED__ = true;

  var POST_MSG_KEY = '__ds_usage_record__';

  // 仅拦截 DeepSeek 域名下的对话类接口
  var HOST_RE = /(^|\.)deepseek\.com$/i;
  // Chat: /chat/completions；FIM: /completions；Responses: /responses；
  // Anthropic 兼容：/anthropic/v1/messages（vN 可选）
  var PATH_RE = /(chat\/completions?|(^|\/)completions?($|[?/])|(^|\/)responses($|[?/])|anthropic\/(?:v\d+\/)?messages)/i;

  function isTargetUrl(url) {
    try {
      var u = new URL(url, location.href);
      return HOST_RE.test(u.hostname) && PATH_RE.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  /** 去掉 query（可能含敏感参数），只保留源 + 路径 */
  function safeUrl(url) {
    try {
      var u = new URL(url, location.href);
      return u.origin + u.pathname;
    } catch (e) {
      return String(url || '').split('?')[0];
    }
  }

  function postRecord(record) {
    try {
      window.postMessage({ __dsUsage: true, payload: record }, '*');
    } catch (e) { /* 忽略 */ }
  }

  function getModelFromBody(body) {
    if (typeof body !== 'string' || !body) return '';
    try {
      var j = JSON.parse(body);
      return j && typeof j.model === 'string' ? j.model : '';
    } catch (e) {
      return '';
    }
  }

  /* ---------------- usage 归一化 ----------------
   * 不同形态的字段：
   *  Chat/FIM: prompt_tokens, completion_tokens, total_tokens,
   *            prompt_cache_hit_tokens, prompt_cache_miss_tokens,
   *            prompt_tokens_details.cached_tokens
   *  Responses: input_tokens, output_tokens, total_tokens,
   *             input_tokens_details.cached_tokens
   *  Anthropic: input_tokens(未命中输入), output_tokens,
   *             cache_read_input_tokens(命中), cache_creation_input_tokens(写缓存)
   * 流式 SSE 中字段可能分散在多个 chunk，逐 chunk 合并（数值取大，兼容累计快照）。
   * ------------------------------------------------ */

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function pickDetailsCached(u) {
    // OpenAI 风格 prompt_tokens_details.cached_tokens
    if (u && u.prompt_tokens_details && typeof u.prompt_tokens_details.cached_tokens === 'number') {
      return u.prompt_tokens_details.cached_tokens;
    }
    // Responses 风格 input_tokens_details.cached_tokens
    if (u && u.input_tokens_details && typeof u.input_tokens_details.cached_tokens === 'number') {
      return u.input_tokens_details.cached_tokens;
    }
    return null;
  }

  function mergeUsage(acc, u) {
    if (!u || typeof u !== 'object') return acc;
    acc = acc || { inputRaw: 0, output: 0, totalGiven: null, hit: 0, missGiven: null, cacheWrite: 0, anthropic: false };

    var input = num(u.prompt_tokens) || num(u.input_tokens);
    if (input > acc.inputRaw) acc.inputRaw = input;

    var output = num(u.completion_tokens) || num(u.output_tokens);
    if (output > acc.output) acc.output = output;

    if (typeof u.total_tokens === 'number' && u.total_tokens > (acc.totalGiven || 0)) {
      acc.totalGiven = num(u.total_tokens);
    }

    // 缓存命中
    var hit = num(u.prompt_cache_hit_tokens);
    var detailsCached = pickDetailsCached(u);
    if (detailsCached !== null) hit = Math.max(hit, num(detailsCached));
    if (typeof u.cache_read_input_tokens === 'number') {
      hit = Math.max(hit, num(u.cache_read_input_tokens));
      acc.anthropic = true; // Anthropic 形态：input_tokens 不含缓存部分
    }
    if (hit > acc.hit) acc.hit = hit;

    // 显式未命中字段
    if (typeof u.prompt_cache_miss_tokens === 'number') {
      acc.missGiven = Math.max(acc.missGiven || 0, num(u.prompt_cache_miss_tokens));
    }
    // Anthropic 写缓存按未命中计费
    if (typeof u.cache_creation_input_tokens === 'number') {
      acc.cacheWrite = Math.max(acc.cacheWrite, num(u.cache_creation_input_tokens));
      acc.anthropic = true;
    }
    return acc;
  }

  function finalize(acc, model, url) {
    if (!acc) return null;
    var hit = acc.hit;
    var miss;
    var prompt;

    if (acc.missGiven !== null) {
      // OpenAI/Chat/FIM：显式给出未命中数；prompt_tokens = hit + miss
      miss = acc.missGiven;
      prompt = Math.max(acc.inputRaw, hit + miss);
    } else if (acc.anthropic) {
      // Anthropic：input_tokens 即未命中输入（不含缓存读写），写缓存计入未命中
      miss = acc.inputRaw + acc.cacheWrite;
      prompt = acc.inputRaw + hit + acc.cacheWrite;
    } else {
      // Responses：input_tokens 含 cached_tokens，未命中 = input - cached
      miss = Math.max(0, acc.inputRaw - hit);
      prompt = Math.max(acc.inputRaw, hit + miss);
    }

    var completion = acc.output;
    var total = acc.totalGiven !== null ? acc.totalGiven : prompt + completion;

    // 没有任何有效 token 数据则不上报
    if (!total && !prompt && !completion) return null;

    return {
      ts: Date.now(),
      url: safeUrl(url),
      model: model || '',
      prompt: prompt,
      completion: completion,
      total: total,
      hit: hit,
      miss: miss
    };
  }

  /** 从完整响应文本（JSON 或 SSE）中提取并归一化 usage */
  function analyzeResponseText(text, url, fallbackModel) {
    if (!text || typeof text !== 'string') return null;
    var acc = null;
    var model = fallbackModel || '';

    if (text.indexOf('data:') !== -1) {
      // ---- SSE 流式：逐行解析 data: {...} ----
      var lines = text.split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        var obj;
        try { obj = JSON.parse(payload); } catch (e) { continue; }
        if (!obj) continue;
        // Chat/FIM：obj.usage；Responses：obj.response.usage；Anthropic：obj.message.usage / obj.usage
        var u = obj.usage || (obj.response && obj.response.usage) || (obj.message && obj.message.usage);
        if (u) acc = mergeUsage(acc, u);
        var m = obj.model || (obj.response && obj.response.model) || (obj.message && obj.message.model);
        if (!model && typeof m === 'string' && m) model = m;
      }
    } else {
      // ---- 普通 JSON ----
      try {
        var j = JSON.parse(text);
        if (j) {
          var u2 = j.usage || (j.response && j.response.usage);
          if (u2) acc = mergeUsage(acc, u2);
          if (!model && typeof j.model === 'string' && j.model) model = j.model;
          if (!model && j.response && typeof j.response.model === 'string') model = j.response.model;
        }
      } catch (e) {
        return null;
      }
    }
    return finalize(acc, model, url);
  }

  /* ---------------- 包装 fetch ---------------- */

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function () {
      var args = arguments;
      var input = args[0];
      var init = args[1] || (typeof Request === 'function' && input instanceof Request ? input : null);
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var bodyModel = '';
      try {
        if (init && typeof init.body === 'string') bodyModel = getModelFromBody(init.body);
      } catch (e) { /* 忽略 */ }

      return originalFetch.apply(this, args).then(function (response) {
        if (isTargetUrl(url)) {
          try {
            // clone 后异步读取，绝不阻塞 / 篡改页面拿到的响应流
            response.clone().text().then(function (text) {
              var rec = analyzeResponseText(text, url, bodyModel);
              if (rec) postRecord(rec);
            }).catch(function () { /* 忽略读取失败 */ });
          } catch (e) { /* 忽略 */ }
        }
        return response;
      });
    };
  }

  /* ---------------- 包装 XMLHttpRequest ---------------- */

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ds_url = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    var url = xhr.__ds_url;
    if (isTargetUrl(url)) {
      var bodyModel = typeof body === 'string' ? getModelFromBody(body) : '';
      xhr.addEventListener('load', function () {
        try {
          if (xhr.readyState !== 4) return;
          var rec = analyzeResponseText(xhr.responseText, url, bodyModel);
          if (rec) postRecord(rec);
        } catch (e) { /* 忽略 */ }
      });
    }
    return originalSend.apply(this, arguments);
  };
})();
