/**
 * ============================================================
 * bill.js - 全平台账单解析与聚合（只关心金额）
 * ============================================================
 * 数据来源：DeepSeek 开放平台「用量信息」页按月导出的压缩包，
 * 内含两个 CSV（表头为官方真实格式）：
 *
 *   cost-*.csv   花费明细
 *     user_id, start_time_iso, end_time_iso, model, wallet_type, cost, currency
 *
 *   amount-*.csv 用量明细（tidy 形态：一行一个指标）
 *     user_id, start_time_iso, end_time_iso, model, api_key_name, api_key, type, price, amount
 *     type ∈ {output_tokens, input_cache_hit_tokens, input_cache_miss_tokens, request_count}
 *
 * 关键：用量明细里的 `amount` 列**不是金额**，它的含义由 `type` 列决定；
 * 真正的金额是 `price × amount`。把它直接当钱会显示出天文数字。
 *
 * 金额口径：
 *   - 总金额 / 按模型 / 充值·赠送拆分 —— 以官方 cost 文件为准（权威）；
 *   - 按 API Key 金额 —— cost 文件没有 Key 列，用用量明细的 price×amount 反推
 *     （已验证与官方总金额一致）；
 *   - 只有用量明细时，总金额也用反推值兜底。
 *
 * 全部为纯函数，无 DOM 依赖，便于 Node 单测。
 * ============================================================
 */

(function (global) {
  'use strict';

  /* ============================ 工具 ============================ */

  /** 宽松数字解析：去除千分位逗号、¥、空格等 */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (v == null) return 0;
    var s = String(v).trim().replace(/[,\s¥￥$]/g, '');
    if (s === '' || s === '--' || s === 'null') return 0;
    var n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 收敛金额的小数误差。
   * 精度取 1e-10：DeepSeek 的单价低至 0.00000005，导出文件里金额有 8 位以上小数，
   * 用 1e-6 会把 0.5882175 直接舍成 0.588218。
   * 注意只在累加结束后调用一次——逐次累加时舍入会让误差不断累积。
   */
  function roundMoney(n) {
    return Math.round((Number(n) || 0) * 1e10) / 1e10;
  }

  /** 从时间字符串中提取 YYYY-MM；无法识别返回 null */
  function monthOfTime(s) {
    if (s == null) return null;
    var m = String(s).match(/(\d{4})[-/.年](\d{1,2})/);
    if (!m) return null;
    var mm = String(m[2]).padStart(2, '0');
    return m[1] + '-' + mm;
  }

  /* ============================ CSV 解析 ============================ */

  /**
   * 解析 CSV 文本（支持引号包裹、引号内逗号/换行、双引号转义、CRLF、BOM）。
   * @returns {Array<Object>} 以表头为键的对象数组，空表返回 []
   */
  function parseCSV(text) {
    if (text == null) return [];
    var s = String(text).replace(/^﻿/, ''); // 去 BOM

    var rows = [];
    var field = '';
    var row = [];
    var inQuotes = false;
    var i = 0;
    var c;

    function pushField() {
      row.push(field);
      field = '';
    }
    function pushRow() {
      rows.push(row);
      row = [];
    }

    while (i < s.length) {
      c = s[i];
      if (inQuotes) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { pushField(); i++; continue; }
      if (c === '\r') {
        pushField();
        pushRow();
        if (s[i + 1] === '\n') i += 2;
        else i++;
        continue;
      }
      if (c === '\n') { pushField(); pushRow(); i++; continue; }
      field += c;
      i++;
    }
    // 最后一个字段 / 行（文件末尾无换行）
    if (field !== '' || row.length) {
      pushField();
      pushRow();
    }

    if (!rows.length) return [];
    var headers = rows[0].map(function (h) { return String(h).trim(); });
    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var cells = rows[r];
      if (!cells || (cells.length === 1 && String(cells[0]).trim() === '')) continue;
      var obj = {};
      for (var k = 0; k < headers.length; k++) {
        obj[headers[k]] = cells[k] == null ? '' : cells[k];
      }
      out.push(obj);
    }
    return out;
  }

  /* ====================== 表头（字段）识别 ====================== */

  /**
   * 列名匹配规则。采用锚定匹配而不是「包含即命中」：
   * 之前用宽泛匹配时，用量明细里名为 `amount` 的列被误当成金额列，
   * 导致 token 数量被当成钱显示。
   */
  var COLUMN_RULES = {
    cost: /^(cost|金额|花费|费用|消费)$/i,
    model: /^(model|模型)$/i,
    time: /^(start_time_iso|start_time|end_time_iso|call_time|time|date|时间|日期)$/i,
    keyName: /^(api_key_name|key_name|密钥名称)$/i,
    keyRaw: /^(api_key|key|密钥)$/i,
    type: /^type$/i,
    price: /^(price|单价)$/i,
    amount: /^amount$/i,
    wallet: /^(wallet_type|wallet|钱包类型|钱包)$/i
  };

  /**
   * 建立「规范字段 -> 实际表头」映射（每个字段取第一个命中的表头）。
   * @param {string[]} headers
   */
  function mapHeaders(headers) {
    var map = {};
    var list = (headers || []).map(function (h) {
      return { raw: h, lc: String(h).trim() };
    });
    Object.keys(COLUMN_RULES).forEach(function (field) {
      var re = COLUMN_RULES[field];
      for (var i = 0; i < list.length; i++) {
        if (re.test(list[i].lc)) { map[field] = list[i].raw; break; }
      }
    });
    return map;
  }

  /**
   * 判断 CSV 类型：
   *   'usage'   用量明细（tidy：type + price + amount）
   *   'cost'    花费明细（含金额列）
   *   'unknown' 无法识别
   */
  function detectKind(headers) {
    var map = mapHeaders(headers);
    if (map.type && map.price && map.amount) return 'usage';
    if (map.cost) return 'cost';
    return 'unknown';
  }

  /* ============================ 行归一化 ============================ */

  /**
   * 将 CSV 行归一化为统一记录：
   * { time, model, key, amount, walletType, src }
   * @param {Array<Object>} rows parseCSV 的结果
   * @param {string} kind 'usage' | 'cost' | 'unknown'
   * @returns {Array<Object>}
   */
  function normalizeRows(rows, kind) {
    if (!rows || !rows.length || kind === 'unknown') return [];
    var headers = Object.keys(rows[0]);
    var map = mapHeaders(headers);
    var get = function (row, field) {
      var h = map[field];
      return h == null ? '' : row[h];
    };

    var records = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var time = String(get(row, 'time') || '').trim();
      var model = String(get(row, 'model') || '').trim();

      if (kind === 'cost') {
        var cost = num(get(row, 'cost'));
        if (!cost) continue; // 金额为 0 的行不产生账单意义
        records.push({
          time: time,
          model: model,
          key: '', // 花费明细没有 Key 列
          amount: cost,
          walletType: String(get(row, 'wallet') || '').trim(),
          src: 'cost'
        });
        continue;
      }

      // 用量明细：request_count 行记录的是次数，不是钱
      var type = String(get(row, 'type') || '').trim();
      if (/request[_\s-]?count/i.test(type)) continue;

      var money = num(get(row, 'price')) * num(get(row, 'amount'));
      if (!money) continue;
      records.push({
        time: time,
        model: model,
        key: String(get(row, 'keyName') || get(row, 'keyRaw') || '').trim(),
        amount: money,
        walletType: '',
        src: 'usage'
      });
    }
    return records;
  }

  /* ============================ 聚合 ============================ */

  function emptyGroup() {
    return { amount: 0, rows: 0 };
  }

  /** 原样累加，不做中间舍入（见 roundMoney 的说明） */
  function addToGroup(g, rec) {
    g.amount += rec.amount || 0;
    g.rows += 1;
  }

  /** 累加结束后统一收敛小数误差 */
  function finalizeGroup(g) {
    g.amount = roundMoney(g.amount);
    return g;
  }

  function finalizeGroups(map) {
    Object.keys(map).forEach(function (k) { finalizeGroup(map[k]); });
    return map;
  }

  /**
   * 聚合金额：
   *   total / byModel / wallet —— 优先用官方 cost 明细；
   *   byKey —— 只有用量明细带 Key，故始终从用量明细汇总。
   * @param {Array<Object>} records normalizeRows 的结果
   */
  function aggregate(records) {
    var list = records || [];
    var costRows = [];
    var usageRows = [];
    list.forEach(function (r) {
      if (r && r.src === 'cost') costRows.push(r);
      else if (r) usageRows.push(r);
    });

    // 官方 cost 文件是权威口径；没有它时用用量明细反推值兜底
    var moneyRows = costRows.length ? costRows : usageRows;

    var total = emptyGroup();
    var byModel = {};
    var byKey = {};
    var wallet = {};

    moneyRows.forEach(function (rec) {
      addToGroup(total, rec);
      var modelName = rec.model || '未标注模型';
      if (!byModel[modelName]) byModel[modelName] = emptyGroup();
      addToGroup(byModel[modelName], rec);
    });

    costRows.forEach(function (rec) {
      var w = rec.walletType || '未标注';
      wallet[w] = (wallet[w] || 0) + (rec.amount || 0);
    });

    usageRows.forEach(function (rec) {
      var keyName = rec.key || '未标注 Key';
      if (!byKey[keyName]) byKey[keyName] = emptyGroup();
      addToGroup(byKey[keyName], rec);
    });

    finalizeGroup(total);
    finalizeGroups(byModel);
    finalizeGroups(byKey);
    Object.keys(wallet).forEach(function (k) { wallet[k] = roundMoney(wallet[k]); });

    return { total: total, byKey: byKey, byModel: byModel, wallet: wallet };
  }

  /**
   * 按记录自身的时间分月。
   * 官方导出是按月分文件的，但用户可以一次多选多个文件/多个包导入，
   * 若全部并进「出现次数最多的那个月」，跨月数据会被静默混在一起。
   * 时间无法识别的记录归入 'unknown'。
   * @returns {Object<string, Array>} { 'YYYY-MM': [记录…] }
   */
  function groupByMonth(records) {
    var groups = {};
    (records || []).forEach(function (rec) {
      var m = monthOfTime(rec && rec.time) || 'unknown';
      if (!groups[m]) groups[m] = [];
      groups[m].push(rec);
    });
    return groups;
  }

  /**
   * 按月聚合，供手动导入与登录态自动拉取共用。
   * @returns {Object<string, {agg: object, records: number}>}
   */
  function aggregateByMonth(records) {
    var groups = groupByMonth(records);
    var out = {};
    Object.keys(groups).forEach(function (m) {
      out[m] = { agg: aggregate(groups[m]), records: groups[m].length };
    });
    return out;
  }

  /** 取记录中出现次数最多的月份（用于账单归档） */
  function deriveMonth(records) {
    var counts = {};
    for (var i = 0; i < (records || []).length; i++) {
      var m = monthOfTime(records[i].time);
      if (m) counts[m] = (counts[m] || 0) + 1;
    }
    var best = null;
    var bestN = 0;
    Object.keys(counts).forEach(function (m) {
      if (counts[m] > bestN) { best = m; bestN = counts[m]; }
    });
    return best;
  }

  /* ============================ ZIP 解析 ============================ */

  function inflateRaw(compressed) {
    // Chrome/Edge 103+ 支持 DecompressionStream('deflate-raw')
    if (typeof DecompressionStream === 'undefined') {
      return Promise.reject(new Error('当前浏览器不支持 DecompressionStream，无法解压 zip'));
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([compressed]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer();
  }

  /**
   * 最小 ZIP 读取器（仅读取，不写入）：
   * 遍历中央目录，支持 method 0（store）/ 8（deflate）。
   * @param {ArrayBuffer} buf
   * @returns {Promise<Array<{name:string, text:string}>>} 仅返回 .csv 条目
   */
  async function parseZip(buf) {
    var dv = new DataView(buf);
    var u8 = new Uint8Array(buf);

    // 从文件尾部定位 EOCD（0x06054b50）
    var eocd = -1;
    var start = Math.max(0, u8.length - 22 - 65536);
    for (var i = u8.length - 22; i >= start; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('无法识别的 zip 文件（未找到 EOCD）');

    var cdOffset = dv.getUint32(eocd + 16, true);
    var cdCount = dv.getUint16(eocd + 10, true);
    var entries = [];
    var p = cdOffset;

    for (var n = 0; n < cdCount; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break; // 中央目录头
      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOffset = dv.getUint32(p + 42, true);
      var nameBytes = u8.slice(p + 46, p + 46 + nameLen);
      var name = new TextDecoder('utf-8').decode(nameBytes);
      p += 46 + nameLen + extraLen + commentLen;

      if (/\/$/.test(name) || /__MACOSX/.test(name)) continue;
      if (!/\.csv$/i.test(name)) continue;

      // 本地文件头：数据起点需跳过其 name/extra
      var localNameLen = dv.getUint16(localOffset + 26, true);
      var localExtraLen = dv.getUint16(localOffset + 28, true);
      var dataStart = localOffset + 30 + localNameLen + localExtraLen;
      var data = u8.slice(dataStart, dataStart + compSize);

      var textBytes;
      if (method === 0) {
        textBytes = data;
      } else if (method === 8) {
        textBytes = new Uint8Array(await inflateRaw(data));
      } else {
        throw new Error('zip 使用了不支持的压缩方式（method ' + method + '）');
      }
      var text = new TextDecoder('utf-8').decode(textBytes);
      var shortName = name.split('/').pop();
      entries.push({ name: shortName, text: text });
    }
    return entries;
  }

  /* ==================== 高层：解析账单数据 ==================== */

  /**
   * 解析用户通过 file input 选择的文件（.zip 或 .csv，可多选）。
   * @param {Array<File>} files
   */
  async function parseFiles(files) {
    var warnings = [];
    var items = []; // {name, text}

    for (var f = 0; f < (files || []).length; f++) {
      var file = files[f];
      var lname = file.name.toLowerCase();
      try {
        if (lname.endsWith('.zip')) {
          var zipped = await parseZip(await file.arrayBuffer());
          if (!zipped.length) warnings.push('压缩包「' + file.name + '」中未找到 CSV 文件');
          for (var z = 0; z < zipped.length; z++) {
            items.push({ name: zipped[z].name, text: zipped[z].text });
          }
        } else if (lname.endsWith('.csv')) {
          items.push({ name: file.name, text: await file.text() });
        } else {
          warnings.push('已忽略不支持的文件：' + file.name);
        }
      } catch (e) {
        warnings.push('解析「' + file.name + '」失败：' + (e && e.message ? e.message : e));
      }
    }

    var result = parseTexts(items);
    return {
      month: result.month,
      records: result.records,
      files: result.files,
      warnings: warnings.concat(result.warnings)
    };
  }

  /**
   * 解析一批「文件名 + CSV 文本」。
   * 手动导入（ZIP 解出的条目 / 单个 .csv）与登录态自动拉取（导出 ZIP）
   * 走的都是这一条路径，保证两种方式得到完全一致的口径。
   * @param {Array<{name: string, text: string}>} items
   */
  function parseTexts(items) {
    var warnings = [];
    var parsed = []; // {name, kind, rows}

    (items || []).forEach(function (it) {
      if (!it || typeof it.text !== 'string' || !it.text) return;
      var rows = parseCSV(it.text);
      if (!rows.length) return;
      parsed.push({ name: it.name || '', kind: detectKind(Object.keys(rows[0])), rows: rows });
    });

    var hasCost = parsed.some(function (x) { return x.kind === 'cost'; });
    var hasUsage = parsed.some(function (x) { return x.kind === 'usage'; });
    if (!hasCost && !hasUsage) {
      warnings.push('未找到可识别的账单明细（需要官方导出的花费明细或用量明细 CSV）');
    } else if (!hasCost) {
      warnings.push('未找到花费明细（cost）CSV，金额将由用量明细反推');
    } else if (!hasUsage) {
      warnings.push('未找到用量明细（amount）CSV，按 API Key 的金额明细将缺失');
    }

    var records = [];
    parsed.forEach(function (x) {
      records = records.concat(normalizeRows(x.rows, x.kind));
    });

    if ((hasCost || hasUsage) && !records.length) {
      warnings.push('明细里没有解析出任何金额记录');
    }

    return {
      month: deriveMonth(records),
      records: records,
      files: parsed.map(function (x) { return { name: x.name, kind: x.kind, rows: x.rows.length }; }),
      warnings: warnings
    };
  }

  /* ==================== 平台导出（登录态自动拉取） ==================== */

  /**
   * 计算某个月的导出时间窗（Unix 秒，UTC 日界）。
   * 平台用量导出接口形如：
   *   GET /api/v0/usage/export?start=<秒>&end=<秒>&tz=<分钟>
   * @param {string} [month] 'YYYY-MM'，为空则取当前月
   * @param {number} [now] 当前时间戳（便于测试）
   * @returns {{start: number, end: number, tz: number}}
   */
  function usageExportRange(month, now) {
    var m = /^(\d{4})-(\d{1,2})$/.exec(String(month == null ? '' : month).trim());
    var year;
    var monthIndex;
    if (m) {
      year = Number(m[1]);
      monthIndex = Number(m[2]) - 1;
      if (monthIndex < 0 || monthIndex > 11) {
        year = NaN; // 非法月份，退回当前月
      }
    }
    if (!Number.isFinite(year)) {
      var d = new Date(now == null ? Date.now() : now);
      year = d.getUTCFullYear();
      monthIndex = d.getUTCMonth();
    }
    return {
      start: Date.UTC(year, monthIndex, 1) / 1000,
      end: Date.UTC(year, monthIndex + 1, 1) / 1000,
      tz: 0
    };
  }

  /**
   * 从 localStorage 里 userToken 的原始值中取出真正的令牌。
   * 平台存的形式是 JSON（形如 {"value":"xxx","expiry":...}），
   * 但某些版本/环境下也可能直接是字符串，两种都要兼容。
   * @param {string} raw
   * @returns {string} 取不到时返回空串
   */
  function extractUserToken(raw) {
    if (raw == null) return '';
    var s = String(raw).trim();
    if (!s) return '';
    if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      try {
        var j = JSON.parse(s);
        if (j && typeof j.value === 'string') return j.value.trim();
        if (j && typeof j.token === 'string') return j.token.trim();
        return '';
      } catch (e) {
        /* 不是合法 JSON，按原始字符串处理 */
      }
    }
    return s;
  }

  /* ============================ 导出 ============================ */

  var API = {
    num: num,
    roundMoney: roundMoney,
    monthOfTime: monthOfTime,
    parseCSV: parseCSV,
    mapHeaders: mapHeaders,
    detectKind: detectKind,
    normalizeRows: normalizeRows,
    aggregate: aggregate,
    aggregateByMonth: aggregateByMonth,
    groupByMonth: groupByMonth,
    deriveMonth: deriveMonth,
    parseZip: parseZip,
    parseFiles: parseFiles,
    parseTexts: parseTexts,
    emptyGroup: emptyGroup,
    usageExportRange: usageExportRange,
    extractUserToken: extractUserToken
  };

  // Popup / content script：挂到全局；Service Worker：importScripts 后同样可用
  global.DS_BILL = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
