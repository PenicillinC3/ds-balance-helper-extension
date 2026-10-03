/**
 * 后台 service worker 的余额写入口径。
 * 重点：chrome.storage 的「读 → 改 → 写」不是原子的，
 * 并发刷新必须在后台排队执行，否则后写会覆盖先写、已记下的消耗丢失。
 */

const test = require('node:test');
const assert = require('node:assert');
const { createBackgroundEnv } = require('./helpers/extension-env');

test('并发刷新两次余额时，消耗累计不会被覆盖（中间发生充值）', { timeout: 5000 }, async () => {
  // 场景：余额 100 →（用掉 15）→ 85 →（充值到）→ 95
  // 只有按顺序处理才能得到：消耗 15 元、上次余额 95。
  // 若两次刷新并发读改（都读到 prev=100），后写的那个会把前一次
  // 记下的下降值整个覆盖掉，消耗被少记。
  const env = createBackgroundEnv({
    initial: { ds_api_key: 'sk-test', ds_prev_balance: 100, ds_consumed: 0 },
    holdReads: { key: 'ds_prev_balance', count: 2 },
  });
  env.balanceQueue.push({ available: 85 }, { available: 95 });

  await Promise.all([env.sandbox.refreshAndStore(), env.sandbox.refreshAndStore()]);

  assert.equal(env.storage.store.ds_consumed, 15, '100→85 的下降必须被记住，不能在充值后被覆盖');
  assert.equal(env.storage.store.ds_prev_balance, 95);
});

test('余额刷新成功后写入快照并清除历史错误', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    initial: {
      ds_api_key: 'sk-test',
      ds_last_error: { error: 'NETWORK', message: '旧错误', fetchedAt: 1 },
    },
  });
  env.balanceQueue.push({ available: 42.5, toppedUp: 40, granted: 2.5 });

  const resp = await env.sandbox.refreshAndStore({ manual: true });

  assert.equal(resp.ok, true);
  assert.equal(env.storage.store.ds_last_data.available, 42.5);
  assert.equal(env.storage.store.ds_last_data.toppedUp, 40);
  assert.equal(env.storage.store.ds_last_data.granted, 2.5);
  assert.equal(env.storage.store.ds_last_error, undefined, '查询成功应清除历史错误');
});

test('余额刷新失败时不覆盖上一次成功数据', { timeout: 5000 }, async () => {
  const env = createBackgroundEnv({
    initial: {
      ds_api_key: 'sk-test',
      ds_last_data: { available: 42.5, fetchedAt: 1 },
    },
  });
  env.balanceQueue.push({ __networkError: true });

  const resp = await env.sandbox.refreshAndStore();

  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'NETWORK');
  assert.equal(env.storage.store.ds_last_data.available, 42.5, '失败不应清掉上次的成功数据');
  assert.equal(env.storage.store.ds_last_error.error, 'NETWORK');
});
