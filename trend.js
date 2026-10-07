/**
 * ============================================================
 * trend.js - 余额趋势：采样历史的时间序列工具（纯函数）
 * ============================================================
 * 数据来源：后台每次成功查询余额时追加一条 {t, v}。它搭现有定时闹钟的
 * 顺风车，**不额外发任何请求**——所以采样点只在浏览器开着的时候产生。
 * 关着的那段时间并没有被观测过，曲线必须如实画成虚线，而不是拿直线
 * 把两头连起来假装中间看过（见 buildSeries 的 gapMs）。
 *
 * 为什么画的是「余额水位」而不是「每天花了多少」：后者需要账单，也就是
 * 需要登录态；前者只要配了 API Key 就成立，任何用户都能用。
 * 余额的斜率就是消耗速度，充值会表现为向上的台阶。
 *
 * 全部为纯函数，无 DOM 依赖，后台与弹窗共用，便于 Node 单测。
 * ============================================================
 */

(function (global) {
  'use strict';

  /** 保留最近 30 天：10 分钟一档、每天开 10 小时约 1800 个点，约 40KB */
  var RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

  /** 距上一条不足 60 秒的重复写入直接丢弃（连点刷新、定时与手动刷新撞车） */
  var MIN_INTERVAL_MS = 60 * 1000;

  /** 采样间隔超过 30 分钟即视为「没在观测」，那段画虚线 */
  var GAP_MS = 30 * 60 * 1000;

  function isFiniteNumber(n) {
    return typeof n === 'number' && Number.isFinite(n);
  }

  /* ---------------------------- 数据层 ---------------------------- */

  /**
   * 追加一条采样，返回新数组（不修改传入的历史）。
   * 同时负责保留策略与重复写入的过滤。
   * @param {Array<{t:number,v:number}>} history
   * @param {{t:number,v:number}} sample 时间戳（毫秒）与余额
   * @returns {Array<{t:number,v:number}>}
   */
  function appendSample(history, sample) {
    var list = Array.isArray(history) ? history.slice() : [];
    if (!sample) return list;

    var t = Number(sample.t);
    var v = Number(sample.v);
    if (!isFiniteNumber(t) || !isFiniteNumber(v)) return list;

    var last = list.length ? list[list.length - 1] : null;
    if (last && isFiniteNumber(Number(last.t))) {
      // 时间没往前走（含倒退）或间隔太近，都不记录
      if (t - Number(last.t) < MIN_INTERVAL_MS) return list;
    }

    list.push({ t: t, v: v });

    // 保留策略：丢掉 30 天前的点（以最新采样时间为基准）
    var cutoff = t - RETENTION_MS;
    var drop = 0;
    while (drop < list.length && Number(list[drop].t) < cutoff) drop++;
    return drop ? list.slice(drop) : list;
  }

  /** 取时间窗 [from, to] 内的采样点 */
  function sliceRange(history, from, to) {
    return (Array.isArray(history) ? history : []).filter(function (s) {
      return s && isFiniteNumber(Number(s.t)) && Number(s.t) >= from && Number(s.t) <= to;
    });
  }

  /**
   * 降采样到至多 maxPoints 个点。
   *
   * 按桶取「最小 + 最大」而不是等距抽样：等距抽样会把桶内的极值整个跳过去，
   * 一笔充值造成的跳升可能被抹平，曲线就骗人了。
   * 点数没超上限时原样返回。
   */
  function downsample(samples, maxPoints) {
    var list = Array.isArray(samples) ? samples : [];
    var max = Number(maxPoints);
    if (!isFiniteNumber(max) || max < 4 || list.length <= max) return list.slice();

    var buckets = Math.floor(max / 2);
    var out = [];
    for (var b = 0; b < buckets; b++) {
      var start = Math.floor((b * list.length) / buckets);
      var end = Math.floor(((b + 1) * list.length) / buckets);
      if (end <= start) continue;

      var lo = list[start];
      var hi = list[start];
      for (var i = start; i < end; i++) {
        if (Number(list[i].v) < Number(lo.v)) lo = list[i];
        if (Number(list[i].v) > Number(hi.v)) hi = list[i];
      }
      // 极值按时间先后入队，保持曲线的先后关系
      var pair = Number(lo.t) <= Number(hi.t) ? [lo, hi] : [hi, lo];
      if (out[out.length - 1] !== pair[0]) out.push(pair[0]);
      if (out[out.length - 1] !== pair[1]) out.push(pair[1]);
    }
    return out;
  }

  /* ---------------------------- 几何层 ---------------------------- */

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * 按采样间隔把连续观测切成若干段。
   * 间隔超过 gapMs 说明这段时间根本没在观测（浏览器关着 / 闹钟没触发）。
   * @returns {Array<Array<{t:number,v:number}>>}
   */
  function splitByGap(samples, gapMs) {
    var list = samples || [];
    if (!list.length) return [];
    var segments = [];
    var cur = [list[0]];
    for (var i = 1; i < list.length; i++) {
      if (Number(list[i].t) - Number(list[i - 1].t) > gapMs) {
        segments.push(cur);
        cur = [];
      }
      cur.push(list[i]);
    }
    segments.push(cur);
    return segments;
  }

  /**
   * 把采样点变成可直接画进 SVG 的几何数据。
   *
   * Y 轴按数据范围自适应而不是从 0 起：余额在 100 上下浮动时，
   * 从 0 起会把整条曲线压成一条看不出消耗速度的平线。代价是纵向变化
   * 会被放大，所以界面必须同时标出最大值与最小值（min / max）。
   *
   * 缺口判定必须在降采样**之前**做：降采样会把相邻点距拉大到一小时以上，
   * 若先降采样再判间隔，一条正常的曲线会被误判成处处都是缺口而碎成几十段。
   *
   * @param {Array<{t:number,v:number}>} samples
   * @param {{width?:number,height?:number,padX?:number,padY?:number,gapMs?:number,maxPoints?:number}} [opts]
   * @returns {{paths: Array<{d:string,dashed:boolean}>, dots: Array<{x:number,y:number}>,
   *            last: ({x:number,y:number}|null), min: (number|null), max: (number|null), count: number}}
   */
  function buildSeries(samples, opts) {
    var o = opts || {};
    var width = isFiniteNumber(Number(o.width)) ? Number(o.width) : 284;
    var height = isFiniteNumber(Number(o.height)) ? Number(o.height) : 90;
    var padX = o.padX == null ? 2 : Number(o.padX);
    var padY = o.padY == null ? 12 : Number(o.padY);
    var gapMs = o.gapMs == null ? GAP_MS : Number(o.gapMs);
    var maxPoints = o.maxPoints == null ? 0 : Number(o.maxPoints);

    var raw = (Array.isArray(samples) ? samples : []).filter(function (s) {
      return s && isFiniteNumber(Number(s.t)) && isFiniteNumber(Number(s.v));
    });

    var empty = { paths: [], dots: [], last: null, min: null, max: null, count: raw.length };
    if (raw.length < 2) return empty;

    // 先切段，再按各段长度分配点数预算（避免长段把短段挤得只剩两个点）
    var segments = splitByGap(raw, gapMs).map(function (seg) {
      var budget = maxPoints > 0
        ? Math.max(2, Math.floor((maxPoints * seg.length) / raw.length))
        : seg.length;
      return downsample(seg, budget);
    });
    var list = segments.reduce(function (acc, seg) { return acc.concat(seg); }, []);

    var min = Infinity;
    var max = -Infinity;
    list.forEach(function (s) {
      var v = Number(s.v);
      if (v < min) min = v;
      if (v > max) max = v;
    });

    var span = max - min;
    var usableH = height - padY * 2;
    var usableW = width - padX * 2;
    var t0 = Number(list[0].t);
    var tSpan = Number(list[list.length - 1].t) - t0;

    // 余额一直没变时把线放在正中，避免除以 0
    function yOf(v) {
      return span === 0 ? padY + usableH / 2 : padY + (1 - (Number(v) - min) / span) * usableH;
    }
    function xOf(t) {
      return tSpan === 0 ? padX : padX + ((Number(t) - t0) / tSpan) * usableW;
    }
    function pt(s) {
      return round2(xOf(s.t)) + ' ' + round2(yOf(s.v));
    }

    var paths = [];
    var dots = [];

    segments.forEach(function (seg, idx) {
      if (idx > 0) {
        // 段与段之间没有观测过，用虚线连过去，如实表达「这里是猜的」
        var prev = segments[idx - 1];
        paths.push({
          d: 'M' + pt(prev[prev.length - 1]) + ' L' + pt(seg[0]),
          dashed: true
        });
      }

      if (seg.length >= 2) {
        paths.push({
          d: seg.map(function (s, i) { return (i ? 'L' : 'M') + pt(s); }).join(' '),
          dashed: false
        });
      } else {
        // 孤立点单独画成圆点，否则它会整个消失
        dots.push({ x: round2(xOf(seg[0].t)), y: round2(yOf(seg[0].v)) });
      }
    });

    return {
      paths: paths,
      dots: dots,
      last: { x: round2(xOf(list[list.length - 1].t)), y: round2(yOf(list[list.length - 1].v)) },
      min: min,
      max: max,
      count: raw.length
    };
  }

  /* ---------------------------- 导出 ---------------------------- */

  var API = {
    RETENTION_MS: RETENTION_MS,
    MIN_INTERVAL_MS: MIN_INTERVAL_MS,
    GAP_MS: GAP_MS,
    appendSample: appendSample,
    sliceRange: sliceRange,
    downsample: downsample,
    buildSeries: buildSeries
  };

  global.DS_TREND = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
