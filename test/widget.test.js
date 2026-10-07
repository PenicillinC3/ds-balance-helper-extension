/**
 * 浮窗里的 Token 一行：从账单存储里挑出「最近一个月」并格式化。
 *
 * 浮窗注入到所有网页，读的是 ds_bill_imports。历史版本存下的账单
 * 没有 tokens 字段（1.4.x 只统计金额），不能因此让浮窗崩掉或显示乱码。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createWidgetEnv } = require('./helpers/extension-env');

const api = createWidgetEnv().api;

function billWith(tokens) {
  return { agg: { total: { amount: 1, rows: 1, tokens } }, source: 'auto', importedAt: 1 };
}

test('取最近一个月的 token（月份字符串排序即时间序）', () => {
  const tk = api.latestBillTokens({
    '2026-08': billWith({ hit: 1, miss: 1, output: 1, requests: 1 }),
    '2026-09': billWith({ hit: 100, miss: 20, output: 7, requests: 3 }),
    '2026-10': billWith({ hit: 900, miss: 0, output: 5, requests: 2 }),
  });

  assert.equal(tk.month, '2026-10');
  assert.equal(tk.hit, 900);
});

test('只有 YYYY-MM 形态的键参与挑选，残缺 / 未识别的键一律忽略', () => {
  // 账单键只可能来自 monthOfTime()（恒为零填充的 YYYY-MM）或 'unknown'，
  // 因此这里用严格形态做过滤即可；'2026-9' 这种非规范键不应被当成最新月份。
  const tk = api.latestBillTokens({
    '2026-9': billWith({ hit: 1, miss: 0, output: 0, requests: 1 }),
    '2026-10': billWith({ hit: 2, miss: 0, output: 0, requests: 1 }),
  });
  assert.equal(tk.month, '2026-10');

  const only = api.latestBillTokens({ '2026-9': billWith({ hit: 1, miss: 0, output: 0, requests: 1 }) });
  assert.equal(only, null, '没有规范月份时视为没有数据');
});

test('没有账单 / 账单里没有 token 时返回 null（浮窗不显示该行）', () => {
  assert.equal(api.latestBillTokens(null), null);
  assert.equal(api.latestBillTokens({}), null);
  assert.equal(api.latestBillTokens({ unknown: billWith({ hit: 1 }) }), null, '未识别月份不算数');
  // 1.4.x 存下的旧账单：只有金额，没有 tokens 字段
  assert.equal(
    api.latestBillTokens({ '2026-09': { agg: { total: { amount: 1, rows: 1 } } } }),
    null
  );
});

test('token 全为 0 时不显示（例如只导入了花费明细）', () => {
  assert.equal(
    api.latestBillTokens({ '2026-09': billWith({ hit: 0, miss: 0, output: 0, requests: 0 }) }),
    null
  );
});

test('token 数量按万 / 亿缩写，小数字加千分位', () => {
  assert.equal(api.formatTokens(0), '0');
  assert.equal(api.formatTokens(3419), '3,419');
  assert.equal(api.formatTokens(12345), '1.23 万');
  assert.equal(api.formatTokens(135505536), '1.36 亿');
});

test('浮窗文案区分命中与未命中', () => {
  const text = api.tokenText({ month: '2026-09', hit: 135505536, miss: 2340, output: 3419, requests: 1318 });
  assert.equal(text, '9月 Token 命中 1.36 亿 / 未命中 2,340');

  const title = api.tokenTitle({ month: '2026-09', hit: 135505536, miss: 2340, output: 3419, requests: 1318 });
  assert.match(title, /缓存命中：135,505,536/, '悬停应给出精确数字');
  assert.match(title, /请求次数：1,318 次/);
});
