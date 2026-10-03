/**
 * 平台页内容脚本：用登录态直接拉取官方用量导出包。
 *
 * 关键约束（决定实现方式）：
 *   - 鉴权用 localStorage 里的 userToken（Bearer），cookie 不被该接口接受；
 *   - 返回的是 ZIP，不是 JSON；
 *   - 令牌只在这次请求里用，不落盘、不外传。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createPlatformExportEnv } = require('./helpers/extension-env');
const { makeZip } = require('./helpers/zip');

const COST_CSV = [
  'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
  'u1,2026-09-02T00:00:00+08:00,2026-09-03T00:00:00+08:00,deepseek-v4-pro,Paid,0.5882175,CNY',
  'u1,2026-09-06T00:00:00+08:00,2026-09-07T00:00:00+08:00,deepseek-v4-flash,Paid,18.7445298,CNY',
].join('\n');

const USAGE_CSV = [
  'user_id,start_time_iso,end_time_iso,model,api_key_name,api_key,type,price,amount',
  'u1,2026-09-02T00:00:00+08:00,2026-09-03T00:00:00+08:00,deepseek-v4-pro,tavo,sk-519dd****7ad9,output_tokens,0.0000135,3419',
].join('\n');

const COST_TOTAL = 0.5882175 + 18.7445298;

const EXPORT_ENTRIES = [
  { name: 'amount-2026-09-02_2026-10-01.csv', text: USAGE_CSV },
  { name: 'cost-2026-09-02_2026-10-01.csv', text: COST_CSV },
];

const RANGE = { start: Date.UTC(2026, 8, 1) / 1000, end: Date.UTC(2026, 9, 1) / 1000, tz: 0 };

function zipResponse(entries) {
  return new Response(makeZip(entries), {
    status: 200,
    headers: { 'content-type': 'application/zip' },
  });
}

function envWithToken(extra = {}) {
  return createPlatformExportEnv({
    localStorage: { userToken: JSON.stringify({ value: 'tok-secret', expiry: 1790000000 }), ...extra },
  });
}

test('用登录态拉取导出包并聚合出金额', { timeout: 5000 }, async () => {
  const env = envWithToken();
  env.respondWith(async () => zipResponse(EXPORT_ENTRIES));

  const resp = await env.sendMessage({ type: 'DS_PLATFORM_EXPORT', range: RANGE });

  assert.ok(resp && resp.ok, `应成功：${JSON.stringify(resp)}`);
  assert.equal(resp.month, '2026-09');
  assert.deepEqual(Object.keys(resp.months), ['2026-09'], '应按月份分组返回');

  const agg = resp.months['2026-09'].agg;
  assert.ok(Math.abs(agg.total.amount - COST_TOTAL) < 1e-9, '总金额以官方 cost 文件为准');
  assert.ok(Math.abs(agg.byKey['tavo'].amount - 0.0000135 * 3419) < 1e-9, '按 Key 金额来自用量明细');
});

test('导出包跨月时，各月分别成组（不并进同一个月）', { timeout: 5000 }, async () => {
  const crossMonth = [
    'user_id,start_time_iso,end_time_iso,model,wallet_type,cost,currency',
    'u1,2026-09-30T00:00:00+08:00,2026-10-01T00:00:00+08:00,deepseek-flash,Granted,1.44712352,CNY',
    'u1,2026-10-01T00:00:00+08:00,2026-10-02T00:00:00+08:00,deepseek-flash,Granted,1.07167172,CNY',
  ].join('\n');

  const env = envWithToken();
  env.respondWith(async () => zipResponse([{ name: 'cost-cross.csv', text: crossMonth }]));

  const resp = await env.sendMessage({ type: 'DS_PLATFORM_EXPORT', range: RANGE });

  assert.ok(resp.ok);
  assert.deepEqual(Object.keys(resp.months).sort(), ['2026-09', '2026-10']);
  assert.ok(Math.abs(resp.months['2026-09'].agg.total.amount - 1.44712352) < 1e-9);
  assert.ok(Math.abs(resp.months['2026-10'].agg.total.amount - 1.07167172) < 1e-9);
});

test('请求的是平台导出接口，带 Bearer 令牌与月份时间窗', { timeout: 5000 }, async () => {
  const env = envWithToken();
  env.respondWith(async () => zipResponse(EXPORT_ENTRIES));

  await env.sendMessage({ type: 'DS_PLATFORM_EXPORT', range: RANGE });

  assert.equal(env.fetchCalls.length, 1, '只应发起一次请求');
  const { url, init } = env.fetchCalls[0];
  assert.ok(url.startsWith('https://platform.deepseek.com/api/v0/usage/export?'), `导出接口地址不对：${url}`);
  assert.ok(url.includes(`start=${RANGE.start}`), '应带 start 参数');
  assert.ok(url.includes(`end=${RANGE.end}`), '应带 end 参数');
  assert.equal(init.method, 'GET', '该接口是 GET，没有请求体');
  assert.equal(
    init.headers.Authorization,
    'Bearer tok-secret',
    '鉴权必须用 localStorage 里的 userToken，而不是 cookie'
  );
});

test('页面没有登录态时明确提示先登录', { timeout: 5000 }, async () => {
  const env = createPlatformExportEnv({ localStorage: {} });
  env.respondWith(async () => zipResponse(EXPORT_ENTRIES));

  const resp = await env.sendMessage({ type: 'DS_PLATFORM_EXPORT', range: RANGE });

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'NO_TOKEN');
  assert.match(resp.message, /登录/);
  assert.equal(env.fetchCalls.length, 0, '没有令牌时不应发请求');
});

test('登录态失效（401）时给出可操作的提示', { timeout: 5000 }, async () => {
  const env = envWithToken();
  env.respondWith(async () => new Response('unauthorized', { status: 401 }));

  const resp = await env.sendMessage({ type: 'DS_PLATFORM_EXPORT', range: RANGE });

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'AUTH');
  assert.match(resp.message, /重新登录/);
});

test('返回的不是 ZIP（例如被登录页顶替）时不当作成功', { timeout: 5000 }, async () => {
  const env = envWithToken();
  env.respondWith(async () => new Response('<!DOCTYPE html><html>登录</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  }));

  const resp = await env.sendMessage({ type: 'DS_PLATFORM_EXPORT', range: RANGE });

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'NOT_ZIP');
});

test('非本脚本负责的消息不响应', { timeout: 5000 }, async () => {
  const env = envWithToken();
  env.respondWith(async () => zipResponse(EXPORT_ENTRIES));

  let responded = false;
  env.messageHandlers.forEach((handler) => {
    handler({ type: 'SOMETHING_ELSE' }, {}, () => { responded = true; });
  });

  assert.equal(responded, false, '无关消息不应被响应');
  assert.equal(env.fetchCalls.length, 0);
});
