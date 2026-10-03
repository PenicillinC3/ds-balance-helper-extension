/**
 * 自动拉取（登录态）用到的纯逻辑 + 官方 ZIP 导出的端到端解析。
 *
 * 平台「用量信息」页导出的就是一个 ZIP，扩展手动导入与自动拉取
 * 拿到的是同一种包，因此这条路径必须真的能解开。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BILL = require(path.join(__dirname, '..', 'bill.js'));
const { zipFile } = require('./helpers/zip');

// 官方真实表头（取自平台「用量信息」页的导出包）
const COST_CSV = [
  'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
  'u1,2026-09-02T00:00:00+08:00,2026-09-03T00:00:00+08:00,deepseek-v4-pro,Paid,0.5882175,CNY',
  'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,Paid,18.7445298,CNY',
].join('\n');

const USAGE_CSV = [
  'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
  'u1,2026-09-02T00:00:00+08:00,2026-09-03T00:00:00+08:00,deepseek-v4-pro,tavo,sk-519dd****7ad9,output_tokens,0.0000135,3419',
  'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,Claude Code,sk-abc****1111,input_cache_hit_tokens,0.00000005,135505536',
].join('\n');

const COST_TOTAL = 0.5882175 + 18.7445298;

/* ---------------------- 导出时间窗 ---------------------- */

test('按月份算出的导出时间窗覆盖整月（UTC 日界）', () => {
  const range = BILL.usageExportRange('2026-09');
  assert.equal(range.start, Date.UTC(2026, 8, 1) / 1000);
  assert.equal(range.end, Date.UTC(2026, 9, 1) / 1000);
  assert.equal(range.tz, 0);
});

test('不给月份时按当前月计算', () => {
  const now = Date.UTC(2026, 9, 15, 8, 30); // 2026-10-15
  const range = BILL.usageExportRange(null, now);
  assert.equal(range.start, Date.UTC(2026, 9, 1) / 1000);
  assert.equal(range.end, Date.UTC(2026, 10, 1) / 1000);
});

/* ---------------------- 登录态令牌解析 ---------------------- */

test('userToken 存成 JSON 时能取出其中的令牌', () => {
  assert.equal(
    BILL.extractUserToken('{"value":"tok-123","expiry":1790000000}'),
    'tok-123'
  );
});

test('userToken 直接是字符串时原样返回', () => {
  assert.equal(BILL.extractUserToken('  tok-raw  '), 'tok-raw');
});

test('userToken 缺失或为空时返回空串', () => {
  assert.equal(BILL.extractUserToken(null), '');
  assert.equal(BILL.extractUserToken(''), '');
  assert.equal(BILL.extractUserToken('{}'), '');
});

/* ---------------------- 官方 ZIP 导出端到端 ---------------------- */

test('直接导入官方导出的 ZIP 能正确解析出金额', async () => {
  const file = zipFile('usage_data_2026-09-02_2026-10-01.zip', [
    { name: 'amount-2026-09-02_2026-10-01.csv', text: USAGE_CSV },
    { name: 'cost-2026-09-02_2026-10-01.csv', text: COST_CSV },
  ]);

  const parsed = await BILL.parseFiles([file]);
  assert.equal(parsed.month, '2026-09', '应从行内日期识别出月份');
  assert.equal(parsed.warnings.length, 0, '两个文件都在时不应有警告');

  const agg = BILL.aggregate(parsed.records);
  assert.ok(Math.abs(agg.total.amount - COST_TOTAL) < 1e-9, '总金额以官方 cost 文件为准');
  assert.equal(agg.total.rows, 2);
  assert.ok(Math.abs(agg.byKey['tavo'].amount - 0.0000135 * 3419) < 1e-9, '按 Key 金额来自用量明细');
  assert.ok(Math.abs(agg.byKey['Claude Code'].amount - 0.00000005 * 135505536) < 1e-9);
});

test('ZIP 里只有花费明细时也能解析出金额', async () => {
  const file = zipFile('usage_data_2026-09-02_2026-10-01.zip', [
    { name: 'cost-2026-09-02_2026-10-01.csv', text: COST_CSV },
  ]);
  const parsed = await BILL.parseFiles([file]);
  const agg = BILL.aggregate(parsed.records);

  assert.ok(Math.abs(agg.total.amount - COST_TOTAL) < 1e-9);
  assert.ok(
    parsed.warnings.some((w) => w.includes('用量明细')),
    `应提示没有用量明细（按 Key 明细会缺失），实际：${JSON.stringify(parsed.warnings)}`
  );
});
