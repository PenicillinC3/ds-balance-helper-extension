/**
 * 全平台账单解析与聚合（只关心金额）。
 *
 * 表头取自官方「用量信息」页导出的真实文件：
 *   cost-*.csv   花费明细：user_id, start_time_iso, end_time_iso, model, wallet_type, cost, currency
 *   amount-*.csv 用量明细：user_id, start_time_iso, end_time_iso, model, api_key_name,
 *                          api_key, type, price, amount
 *
 * 关键：用量明细里的 `amount` 列**不是金额**，它的含义由 `type` 列决定
 * （output_tokens / input_cache_hit_tokens / input_cache_miss_tokens / request_count）。
 * 真正的金额是 `price × amount`。把它当钱会显示出天文数字。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const BILL = require(path.join(__dirname, '..', 'bill.js'));

const COST_CSV = [
  'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
  'u1,2026-09-02T00:00:00+08:00,2026-09-03T00:00:00+08:00,deepseek-v4-pro,Paid,0.5882175,CNY',
  'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,Paid,18.7445298,CNY',
  'u1,2026-09-30T00:00:00+08:00,2026-10-01T00:00:00+08:00,deepseek-flash,Granted,1.44712352,CNY',
].join('\n');

const USAGE_CSV = [
  'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
  'u1,2026-09-02T00:00:00+08:00,2026-09-03T00:00:00+08:00,deepseek-v4-pro,tavo,sk-519dd****7ad9,output_tokens,0.0000135,3419',
  'u1,2026-09-02T00:00:00+08:00,2026-09-03T00:00:00+08:00,deepseek-v4-pro,tavo,sk-519dd****7ad9,request_count,,1',
  'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,Claude Code,sk-abc****1111,input_cache_hit_tokens,0.00000005,135505536',
  'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,Claude Code,sk-abc****1111,request_count,,1317',
].join('\n');

const COST_TOTAL = 0.5882175 + 18.7445298 + 1.44712352;         // 20.77987082
const USAGE_TAVO = 0.0000135 * 3419;                             // 0.0461565
const USAGE_CLAUDE = 0.00000005 * 135505536;                     // 6.7752768

function csvFile(name, text) {
  return new File([text], name, { type: 'text/csv' });
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}：期望 ${expected}，实际 ${actual}`);
}

test('花费明细：按 cost 列汇总金额', async () => {
  const parsed = await BILL.parseFiles([csvFile('cost-2026-09-02_2026-10-01.csv', COST_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.total.amount, COST_TOTAL, '总金额应为三行 cost 之和');
  assert.equal(agg.total.rows, 3);
});

test('用量明细：金额由 price×amount 得出，request_count 行不计', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.total.amount, USAGE_TAVO + USAGE_CLAUDE, '金额应为 price×amount 之和');
  assert.equal(agg.total.rows, 2, 'request_count 行不是金额，不应计入行数');
});

test('用量明细的 amount 列绝不能被当成金额', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  assert.ok(agg.total.amount < 10, `总金额应是几元，而不是 token 数量级的 ${agg.total.amount}`);
  assert.ok(
    !Object.values(agg.byKey).some((g) => g.amount > 100),
    '按 Key 金额也不能出现 token 数量级的数值'
  );
});

test('按 API Key 明细：用 api_key_name 作为 Key 名称', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.byKey['tavo'].amount, USAGE_TAVO, 'tavo 的金额');
  close(agg.byKey['Claude Code'].amount, USAGE_CLAUDE, 'Claude Code 的金额');
  assert.equal(Object.keys(agg.byKey).length, 2, '不应出现多余的 Key 分组');
});

test('两个文件同时导入：总金额以官方 cost 文件为准，不重复相加', async () => {
  const parsed = await BILL.parseFiles([
    csvFile('cost-2026-09-02_2026-10-01.csv', COST_CSV),
    csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV),
  ]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.total.amount, COST_TOTAL, '总金额应等于 cost 文件，而不是两个文件相加');
  close(agg.byKey['tavo'].amount, USAGE_TAVO, '按 Key 金额仍来自用量明细');
});

test('按 wallet_type 拆分充值 / 赠送金额', async () => {
  const parsed = await BILL.parseFiles([csvFile('cost-2026-09-02_2026-10-01.csv', COST_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.wallet.Paid, 0.5882175 + 18.7445298, '充值消费');
  close(agg.wallet.Granted, 1.44712352, '赠送消费');
});

test('按模型金额', async () => {
  const parsed = await BILL.parseFiles([csvFile('cost-2026-09-02_2026-10-01.csv', COST_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.byModel['deepseek-v4-pro'].amount, 0.5882175, 'deepseek-v4-pro');
  close(agg.byModel['deepseek-flash'].amount, 1.44712352, 'deepseek-flash');
});

test('一次导入跨月数据时，按月分别聚合（不能并进同一个月）', async () => {
  const crossMonth = [
    'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
    'u1,2026-09-30T00:00:00+08:00,2026-10-01T00:00:00+08:00,deepseek-flash,Granted,1.44712352,CNY',
    'u1,2026-10-01T00:00:00+08:00,2026-10-02T00:00:00+08:00,deepseek-flash,Granted,1.07167172,CNY',
  ].join('\n');

  const parsed = await BILL.parseFiles([csvFile('cost-cross.csv', crossMonth)]);
  const byMonth = BILL.aggregateByMonth(parsed.records);

  assert.deepEqual(Object.keys(byMonth).sort(), ['2026-09', '2026-10']);
  close(byMonth['2026-09'].agg.total.amount, 1.44712352, '9 月金额');
  close(byMonth['2026-10'].agg.total.amount, 1.07167172, '10 月金额');
});

test('时间无法识别的记录归入 unknown 月份', () => {
  const byMonth = BILL.aggregateByMonth([
    { time: '', model: 'deepseek-flash', key: '', amount: 1.5, walletType: 'Paid', src: 'cost' },
  ]);
  assert.deepEqual(Object.keys(byMonth), ['unknown']);
});

test('只有用量明细（没有 cost 文件）时，用反推金额兜底', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.total.amount, USAGE_TAVO + USAGE_CLAUDE, '没有官方 cost 时用反推金额');
});

test('既没有金额也没有可反推数据时给出警告', async () => {
  const tokenOnly = [
    'utc_date,model,prompt_tokens,completion_tokens',
    '2026-09-01,deepseek-chat,1000,500',
  ].join('\n');
  const parsed = await BILL.parseFiles([csvFile('tokens.csv', tokenOnly)]);
  const agg = BILL.aggregate(parsed.records);

  assert.equal(agg.total.amount, 0);
  assert.ok(
    parsed.warnings.some((w) => w.includes('账单明细')),
    `应提示没有可识别的账单明细，实际警告：${JSON.stringify(parsed.warnings)}`
  );
});

/* ------------------------- Token 用量 ------------------------- */

const HIT = 135505536; // input_cache_hit_tokens
const OUTPUT = 3419;    // output_tokens
const CALLS = 1 + 1317; // request_count 行之和

test('用量明细：按 type 汇总缓存命中 / 未命中 / 输出 / 请求次数', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  assert.equal(agg.total.tokens.hit, HIT, '缓存命中 token');
  assert.equal(agg.total.tokens.miss, 0, '本样本没有未命中行');
  assert.equal(agg.total.tokens.output, OUTPUT, '输出 token');
  assert.equal(agg.total.tokens.requests, CALLS, 'request_count 行累加为请求次数');
});

test('request_count 行只计次数、不计金额', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  assert.equal(agg.total.tokens.requests, 1318);
  close(agg.total.amount, USAGE_TAVO + USAGE_CLAUDE, '请求次数不能被当成金额');
  assert.equal(agg.total.rows, 2, '请求次数行不应计入金额记录数');
});

test('两个文件都在时，token 仍来自用量明细（cost 文件没有 token 信息）', async () => {
  const parsed = await BILL.parseFiles([
    csvFile('cost-2026-09-02_2026-10-01.csv', COST_CSV),
    csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV),
  ]);
  const agg = BILL.aggregate(parsed.records);

  close(agg.total.amount, COST_TOTAL, '金额以 cost 文件为准');
  assert.equal(agg.total.tokens.hit, HIT, 'token 不受金额口径切换影响');
  assert.equal(agg.total.tokens.output, OUTPUT);
  assert.equal(agg.total.tokens.requests, CALLS);
});

test('token 数量不会被当成金额，金额也不会被当成 token', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  assert.ok(agg.total.amount < 10, `总金额应是几元，实际 ${agg.total.amount}`);
  assert.ok(agg.total.tokens.hit > 1e8, `命中 token 应是亿级，实际 ${agg.total.tokens.hit}`);
});

test('按 Key 与按模型分别给出 token 明细', async () => {
  const parsed = await BILL.parseFiles([csvFile('amount-2026-09-02_2026-10-01.csv', USAGE_CSV)]);
  const agg = BILL.aggregate(parsed.records);

  assert.equal(agg.byKey['Claude Code'].tokens.hit, HIT);
  assert.equal(agg.byKey['Claude Code'].tokens.requests, 1317);
  assert.equal(agg.byKey['tavo'].tokens.output, OUTPUT);
  assert.equal(agg.byKey['tavo'].tokens.requests, 1);
  assert.equal(agg.byKey['tavo'].tokens.hit, 0, 'Key 之间的 token 不能串台');

  assert.equal(agg.byModel['deepseek-v4-flash'].tokens.hit, HIT);
  assert.equal(agg.byModel['deepseek-v4-pro'].tokens.output, OUTPUT);
});

test('按月归档时 token 也按月分开', async () => {
  const crossMonth = [
    'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
    'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,k,sk-a,output_tokens,0.0000135,100',
    'u1,2026-10-02T00:00:00+08:00,2026-10-03T00:00:00+08:00,deepseek-v4-flash,k,sk-a,output_tokens,0.0000135,7',
    'u1,2026-10-02T00:00:00+08:00,2026-10-03T00:00:00+08:00,deepseek-v4-flash,k,sk-a,request_count,,3',
  ].join('\n');

  const parsed = await BILL.parseFiles([csvFile('amount-cross.csv', crossMonth)]);
  const byMonth = BILL.aggregateByMonth(parsed.records);

  assert.equal(byMonth['2026-09'].agg.total.tokens.output, 100, '9 月输出 token');
  assert.equal(byMonth['2026-10'].agg.total.tokens.output, 7, '10 月输出 token');
  assert.equal(byMonth['2026-10'].agg.total.tokens.requests, 3, '10 月请求次数');
  assert.equal(byMonth['2026-09'].agg.total.tokens.requests, 0);
});

test('单价缺失的 token 行仍然计数（不能因为没有金额就丢掉 token）', async () => {
  const noPrice = [
    'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
    'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,k,sk-a,input_cache_miss_tokens,,2000',
    'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,k,sk-a,output_tokens,0,300',
  ].join('\n');

  const parsed = await BILL.parseFiles([csvFile('amount-noprice.csv', noPrice)]);
  const agg = BILL.aggregate(parsed.records);

  assert.equal(agg.total.tokens.miss, 2000, '没有单价也要统计未命中 token');
  assert.equal(agg.total.tokens.output, 300, '单价为 0 也要统计输出 token');
  assert.equal(agg.total.amount, 0, '没有有效单价时金额为 0');
});

test('未知的 type 值不会被算进任何 token 桶', async () => {
  const weird = [
    'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
    'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,k,sk-a,something_else,0.5,4',
  ].join('\n');

  const parsed = await BILL.parseFiles([csvFile('amount-weird.csv', weird)]);
  const agg = BILL.aggregate(parsed.records);

  assert.deepEqual(agg.total.tokens, BILL.emptyTokens(), '未知指标不应进入任何桶');
  close(agg.total.amount, 2, '但它的金额仍应照常统计');
});
