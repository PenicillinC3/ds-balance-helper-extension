/**
 * 后台：自动拉取的编排。
 *
 * 登录态与 localStorage 只在平台页面里可用，后台自己发不出这个请求，
 * 因此后台负责「找到平台标签页 → 转交给页面脚本 → 把结果入库」。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createBackgroundEnv } = require('./helpers/extension-env');

const PLATFORM_TAB = { id: 7, url: 'https://platform.deepseek.com/usage' };

function fakeAgg() {
  return {
    total: { requests: 2, prompt: 3000, completion: 1100, total: 4100, hit: 2300, miss: 700, amount: 0.0093, amountRows: 2 },
    byKey: {},
    byModel: {},
  };
}

test('没有打开平台页面时，提示用户先打开并登录', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({ tabs: [] });

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'NO_TAB');
  assert.match(resp.message, /platform\.deepseek\.com/);
  assert.equal(env.sendMessageCalls.length, 0);
});

test('把当前选中月份的时间窗转交给平台页面', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    tabs: [PLATFORM_TAB],
    onSendMessage: () => ({ ok: true, month: '2026-09', agg: fakeAgg(), records: 2 }),
  });

  await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(env.sendMessageCalls.length, 1);
  const call = env.sendMessageCalls[0];
  assert.equal(call.tabId, 7, '应发给平台标签页');
  assert.equal(call.message.type, 'DS_PLATFORM_EXPORT');
  assert.equal(call.message.range.start, Date.UTC(2026, 8, 1) / 1000);
  assert.equal(call.message.range.end, Date.UTC(2026, 9, 1) / 1000);
});

test('拉取成功后按月份写入账单存储，来源标记为自动拉取', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    initial: { ds_bill_imports: { '2026-08': { agg: fakeAgg(), source: 'csv', importedAt: 1 } } },
    tabs: [PLATFORM_TAB],
    onSendMessage: () => ({ ok: true, month: '2026-09', agg: fakeAgg(), records: 2 }),
  });

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(resp.ok, true);
  assert.equal(resp.month, '2026-09');

  const imports = env.storage.store.ds_bill_imports;
  assert.ok(imports['2026-08'], '原有月份的账单不能被清掉');
  assert.equal(imports['2026-09'].source, 'auto');
  assert.deepEqual(imports['2026-09'].agg.total, fakeAgg().total);
  assert.ok(imports['2026-09'].importedAt > 0);
});

test('页面脚本报错时，把原因原样带回给弹窗', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    tabs: [PLATFORM_TAB],
    onSendMessage: () => ({
      ok: false,
      code: 'AUTH',
      message: '登录态已失效，请重新登录 platform.deepseek.com 后刷新页面',
    }),
  });

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'AUTH');
  assert.match(resp.message, /重新登录/);
  assert.equal(env.storage.store.ds_bill_imports, undefined, '失败时不应写入账单');
});

test('平台页面无法通信时给出可操作提示', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({ tabs: [PLATFORM_TAB] });
  env.sandbox.chrome.tabs.sendMessage = async () => {
    throw new Error('Receiving end does not exist.');
  };

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'NO_CONTENT');
  assert.match(resp.message, /刷新/);
});

test('弹窗的自动拉取消息会带上所选月份', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    tabs: [PLATFORM_TAB],
    onSendMessage: () => ({ ok: true, month: '2026-07', agg: fakeAgg(), records: 2 }),
  });

  const handler = env.messageHandlers[0];
  const resp = await new Promise((resolve) => {
    handler({ type: 'DS_BILL_FETCH', month: '2026-07' }, {}, resolve);
  });

  assert.equal(env.sendMessageCalls[0].message.range.start, Date.UTC(2026, 6, 1) / 1000);
  assert.equal(resp.month, '2026-07');
});

/* ---------- 标签页选择 ---------- */

test('同时开着多个平台页时，优先选 /usage 页', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    tabs: [
      { id: 3, url: 'https://platform.deepseek.com/' },
      { id: 7, url: 'https://platform.deepseek.com/usage' },
    ],
    onSendMessage: () => ({ ok: true, month: '2026-09', agg: fakeAgg(), records: 2 }),
  });

  await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(env.sendMessageCalls[0].tabId, 7, '应优先选 /usage 页，而不是首页');
});

test('没有 /usage 页时退回任意平台页', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    tabs: [{ id: 3, url: 'https://platform.deepseek.com/some/other/page' }],
    onSendMessage: () => ({ ok: true, month: '2026-09', agg: fakeAgg(), records: 2 }),
  });

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(resp.ok, true);
  assert.equal(env.sendMessageCalls[0].tabId, 3);
});

/* ---------- 内容脚本失效时现场注入 ---------- */

test('内容脚本已失效时（重载扩展后的已开页面），自动注入并重试', { timeout: 5000 }, async () => {
  // 复现用户实际遇到的场景：页面开着，但里面的内容脚本属于旧的扩展实例，
  // tabs.sendMessage 会抛 "Receiving end does not exist"。
  let injected = false;
  const env = createBackgroundEnv({
    tabs: [PLATFORM_TAB],
    onSendMessage: () => {
      if (!injected) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return { ok: true, month: '2026-09', agg: fakeAgg(), records: 2 };
    },
    onExecuteScript: () => {
      injected = true;
      return [{ result: null }];
    },
  });

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  const filesCall = env.executeScriptCalls.find((c) => Array.isArray(c.files));
  assert.ok(filesCall, '应当现场注入内容脚本');
  assert.equal(filesCall.target.tabId, 7);
  assert.deepEqual(
    filesCall.files,
    ['bill.js', 'platform-export.js'],
    '注入的文件要与 manifest 里注册的一致'
  );
  assert.equal(resp.ok, true, '注入后重试应当成功');
  assert.equal(resp.month, '2026-09');
});

test('注入后仍无法通信时，报错要带上标签页与具体原因', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    tabs: [PLATFORM_TAB],
    onSendMessage: () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
    onExecuteScript: () => [{ result: null }],
  });

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'NO_CONTENT');
  assert.match(resp.message, /usage/, '提示应指向 /usage 页');
  assert.ok(
    Array.isArray(resp.details) && resp.details.length > 0,
    '应带上诊断细节，而不是只给一句话'
  );
});

test('没有平台标签页时，提示指向 /usage', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({ tabs: [] });

  const resp = await env.sandbox.fetchBillFromPlatform('2026-09');

  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'NO_TAB');
  assert.match(resp.message, /\/usage/);
});

/* ---------- 前后台版本自检 ---------- */

test('DS_PING 返回后台版本号，供弹窗判断扩展是否已重新加载', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({ version: '1.4.1' });

  const handler = env.messageHandlers[0];
  const resp = await new Promise((resolve) => {
    handler({ type: 'DS_PING' }, {}, resolve);
  });

  assert.equal(resp.ok, true);
  assert.equal(resp.version, '1.4.1');
});
