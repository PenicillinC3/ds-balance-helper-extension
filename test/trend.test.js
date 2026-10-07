/**
 * 余额趋势：采样历史的时间序列工具。
 *
 * 数据来源是后台每次成功查询余额时追加的 {t, v}，搭现有定时闹钟的顺风车，
 * 不额外发请求。因此采样点只在浏览器开着的时候产生——关着的那段时间曲线是断的，
 * 必须如实画成虚线，而不是拿直线把两头连起来假装中间观测过。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const TREND = require(path.join(__dirname, '..', 'trend.js'));

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 采样点简写 */
function p(t, v) {
  return { t, v };
}

/* ------------------------- 追加与保留 ------------------------- */

test('追加采样：按时间顺序累积', () => {
  let h = [];
  h = TREND.appendSample(h, p(1000 * MIN, 100));
  h = TREND.appendSample(h, p(1010 * MIN, 98));
  h = TREND.appendSample(h, p(1020 * MIN, 95));

  assert.deepEqual(h.map((s) => s.v), [100, 98, 95]);
});

test('追加采样：不修改传入的原数组', () => {
  const before = [p(1000 * MIN, 100)];
  const after = TREND.appendSample(before, p(1010 * MIN, 90));

  assert.equal(before.length, 1, '原数组不能被就地修改');
  assert.equal(after.length, 2);
});

test('追加采样：距上一条不足 60 秒的重复写入被跳过', () => {
  // 连点刷新、后台定时与手动刷新撞车时会产生这种重复
  let h = TREND.appendSample([], p(1000 * MIN, 100));
  h = TREND.appendSample(h, p(1000 * MIN + 30 * SEC, 100));
  h = TREND.appendSample(h, p(1000 * MIN + 59 * SEC, 100));

  assert.equal(h.length, 1, '一分钟内的重复采样应被丢弃');

  h = TREND.appendSample(h, p(1000 * MIN + 60 * SEC, 99));
  assert.equal(h.length, 2, '超过一分钟的新采样应当保留');
});

test('追加采样：时间倒退的采样被丢弃（不会污染曲线顺序）', () => {
  let h = TREND.appendSample([], p(1000 * MIN, 100));
  h = TREND.appendSample(h, p(990 * MIN, 90));

  assert.equal(h.length, 1);
  assert.equal(h[0].v, 100);
});

test('追加采样：超过 30 天的旧点被丢弃', () => {
  const base = 1000 * DAY;
  let h = [];
  h = TREND.appendSample(h, p(base, 100));
  h = TREND.appendSample(h, p(base + 20 * DAY, 80));
  h = TREND.appendSample(h, p(base + 29 * DAY, 60));
  assert.equal(h.length, 3, '30 天内的点都该留着');

  h = TREND.appendSample(h, p(base + 31 * DAY, 40));
  assert.deepEqual(h.map((s) => s.v), [80, 60, 40], '第 1 个点已超过 30 天，应被丢掉');
});

test('追加采样：非法输入原样返回历史', () => {
  const h = [p(1000 * MIN, 100)];
  assert.deepEqual(TREND.appendSample(h, { t: NaN, v: 1 }), h);
  assert.deepEqual(TREND.appendSample(h, { t: 2000 * MIN, v: 'x' }), h);
  assert.deepEqual(TREND.appendSample(h, null), h);
});

test('追加采样：还没有历史时，第一条就能记下', () => {
  assert.deepEqual(TREND.appendSample(null, p(2000 * MIN, 1)), [p(2000 * MIN, 1)]);
  assert.deepEqual(TREND.appendSample([], p(2000 * MIN, 1)), [p(2000 * MIN, 1)]);
});

/* ------------------------- 时间窗与降采样 ------------------------- */

test('按时间窗裁剪', () => {
  const h = [p(0, 1), p(10 * MIN, 2), p(20 * MIN, 3)];
  const got = TREND.sliceRange(h, 5 * MIN, 15 * MIN);

  assert.deepEqual(got.map((s) => s.v), [2], '只保留窗口内的点');
});

test('降采样：点数没超上限时原样返回', () => {
  const h = [p(0, 1), p(MIN, 2), p(2 * MIN, 3)];
  assert.deepEqual(TREND.downsample(h, 10).map((s) => s.v), [1, 2, 3]);
});

test('降采样：压缩到上限以内，且保留首尾', () => {
  const h = [];
  for (let i = 0; i < 1000; i++) h.push(p(i * MIN, 100 - i * 0.01));

  const out = TREND.downsample(h, 60);
  assert.ok(out.length <= 60, `点数应被压到 60 以内，实际 ${out.length}`);
  assert.equal(out[0].t, h[0].t, '首点必须保留');
  assert.equal(out[out.length - 1].t, h[h.length - 1].t, '末点必须保留');
});

test('降采样：不会把充值造成的跳升抹平', () => {
  // 均匀抽样会漏掉这类极值：中间充了一笔，余额跳上去
  const h = [];
  for (let i = 0; i < 500; i++) h.push(p(i * MIN, 100));
  h[250] = p(250 * MIN, 500); // 充值瞬间
  for (let i = 251; i < 500; i++) h[i] = p(i * MIN, 500);

  const out = TREND.downsample(h, 40);
  const max = Math.max(...out.map((s) => s.v));
  assert.equal(max, 500, '跳升的极值必须保留，否则曲线会骗人');
});

/* ------------------------- 曲线几何 ------------------------- */

test('曲线几何：少于 2 个点时不产生路径', () => {
  assert.deepEqual(TREND.buildSeries([], {}).paths, []);
  assert.deepEqual(TREND.buildSeries([p(0, 5)], {}).paths, []);
});

test('曲线几何：Y 轴按数据范围自适应，不锚定到 0', () => {
  // 余额从 100 掉到 90，若 Y 轴从 0 开始，这段变化会被压成一条平线
  const s = TREND.buildSeries([p(0, 100), p(HOUR, 90)], {
    width: 100, height: 100, padX: 0, padY: 0,
  });

  assert.equal(s.min, 90);
  assert.equal(s.max, 100);
  assert.equal(s.paths[0].d, 'M0 0 L100 100', '最高点贴顶、最低点贴底');
});

test('曲线几何：余额完全没变化时画在中间，而不是除零崩掉', () => {
  const s = TREND.buildSeries([p(0, 50), p(HOUR, 50)], {
    width: 100, height: 100, padX: 0, padY: 0,
  });

  assert.equal(s.paths[0].d, 'M0 50 L100 50');
  assert.equal(s.min, 50);
  assert.equal(s.max, 50);
});

test('曲线几何：采样间隔超过阈值时，中间那段画成虚线', () => {
  // 中间隔了 10 小时（浏览器关着），这一段并没有被观测过
  const s = TREND.buildSeries(
    [p(0, 10), p(MIN, 9), p(10 * HOUR, 8)],
    { width: 100, height: 100, padX: 0, padY: 0, gapMs: 30 * MIN }
  );

  assert.equal(s.paths.length, 2, '应为「实线段 + 虚线跨段」两条路径');
  assert.equal(s.paths[0].dashed, false);
  assert.equal(s.paths[1].dashed, true, '跨过长间隔的那段必须是虚线');
  assert.equal(s.dots.length, 1, '孤立点单独画成圆点，否则会消失');
});

test('曲线几何：采样间隔都在阈值内时是一条实线', () => {
  const s = TREND.buildSeries(
    [p(0, 10), p(5 * MIN, 9), p(10 * MIN, 8)],
    { width: 100, height: 100, padX: 0, padY: 0, gapMs: 30 * MIN }
  );

  assert.equal(s.paths.length, 1);
  assert.equal(s.paths[0].dashed, false);
  assert.equal(s.paths[0].d, 'M0 0 L50 50 L100 100');
  assert.deepEqual(s.dots, []);
});

test('曲线几何：点数很多时，缺口必须在降采样之前判定', () => {
  // 1000 个点、每 10 分钟一个，降采样后会变成点距 1 小时以上。
  // 若先降采样再判间隔，一条完全正常的曲线会被误判成处处都是缺口，
  // 碎成几十段虚线（这是真实踩过的坑）。
  const h = [];
  for (let i = 0; i < 1000; i++) h.push(p(i * 10 * MIN, 100 - i * 0.01));

  const s = TREND.buildSeries(h, {
    width: 284, height: 90, gapMs: 30 * MIN, maxPoints: 120,
  });

  assert.equal(s.paths.length, 1, `正常曲线应是一条实线，实际碎成 ${s.paths.length} 段`);
  assert.equal(s.paths[0].dashed, false);
  assert.ok(s.count === 1000, 'count 反映原始点数');
});

test('曲线几何：降采样后点数被压到预算以内', () => {
  const h = [];
  for (let i = 0; i < 1000; i++) h.push(p(i * 10 * MIN, 100 - i * 0.01));

  const s = TREND.buildSeries(h, { gapMs: 30 * MIN, maxPoints: 60 });
  const drawn = (s.paths[0].d.match(/[ML]/g) || []).length;

  assert.ok(drawn <= 60, `画出来的点数应被压到 60 以内，实际 ${drawn}`);
});

test('曲线几何：缺口两侧各自降采样，点数预算不会被长段吃光', () => {
  // 左边一大段连续观测，右边孤立两点 —— 右边不能被降采样吃掉
  const h = [];
  for (let i = 0; i < 500; i++) h.push(p(i * 10 * MIN, 100 - i * 0.01)); // 最后一点在 4990 分钟
  h.push(p(5100 * MIN, 50)); // 隔了 110 分钟没观测
  h.push(p(5110 * MIN, 49));

  const s = TREND.buildSeries(h, { gapMs: 30 * MIN, maxPoints: 60 });

  assert.equal(s.paths.length, 3, '应为「实线 + 虚线跨段 + 实线」');
  assert.equal(s.paths[1].dashed, true);
  assert.equal(s.paths[2].dashed, false, '缺口右边那段必须画出来，不能被吃掉');
});

test('曲线几何：给出末点坐标，供界面标出「当前」', () => {
  const s = TREND.buildSeries([p(0, 100), p(HOUR, 90)], {
    width: 100, height: 100, padX: 0, padY: 0,
  });

  assert.deepEqual(s.last, { x: 100, y: 100 });
  assert.equal(s.count, 2);
});
