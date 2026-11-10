#!/usr/bin/env node
/**
 * 稀土掘金每日签到 + 免费抽奖 — GitHub Actions 版（零依赖，Node 18+）
 *
 * 方案来源：参考 ityadong/node-signin（MIT，2026-06 更新）与 dongwei1125/juejin-helper，
 *   两者都不使用 a_bogus 动态签名，只靠 cookie + 一组固定浏览器指纹请求头即可调通。
 *   实测（2026-11-10）以下接口全部返回正常：
 *     POST /growth_api/v1/check_in            签到
 *     POST /growth_api/v1/lottery/draw        免费抽奖
 *     GET  /growth_api/v2/get_today_status     今日状态
 *     GET  /growth_api/v1/get_counts           连签/累计天数
 *     GET  /growth_api/v1/get_cur_point        当前矿石数
 *
 * 环境变量：
 *   JUEJIN_COOKIE       必填，掘金完整 cookie 字符串
 *   JUEJIN_APPEND_URL   可选，接口附加参数，默认 aid=2608
 *   SERVERCHAN_KEY      可选，Server酱 SendKey
 */

const fs = require('fs');

const BASE = 'https://api.juejin.cn';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildHeaders(cookie) {
  return {
    'user-agent': UA,
    'origin': 'https://juejin.cn',
    'referer': 'https://juejin.cn/',
    'content-type': 'application/json',
    'cookie': cookie,
  };
}

async function call(path, headers, method) {
  const res = await fetch(BASE + path, {
    method: method || 'GET',
    headers,
    body: method === 'POST' ? '{}' : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { __raw: text.slice(0, 200) }; }
  return { http: res.status, json, empty: !text };
}

async function pushServerChan(payload) {
  const key = (process.env.SERVERCHAN_KEY || '').trim();
  if (!key) { log('[notify] 跳过：SERVERCHAN_KEY 未设置'); return { skipped: true }; }
  try {
    const body = new URLSearchParams({
      title: payload.title.slice(0, 32),
      desp: payload.desp,
      short: (payload.short || '').slice(0, 64),
    }).toString();
    const res = await fetch('https://sctapi.ftqq.com/' + key + '.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    const ok = json && json.code === 0;
    log('[notify] Server酱 ' + (ok ? '已推送 pushid=' + (json.data && json.data.pushid || '?') : '失败 http=' + res.status));
    return { ok };
  } catch (e) {
    log('[notify] Server酱 异常: ' + e.message);
    return { ok: false };
  }
}

async function main() {
  const cookie = (process.env.JUEJIN_COOKIE || '').trim();
  const append = (process.env.JUEJIN_APPEND_URL || 'aid=2608').trim();
  const q = '?' + append;
  const result = { platform: 'juejin', time: new Date().toISOString(), ok: false, steps: [], errors: [] };

  if (!cookie) {
    log('::error::缺少 JUEJIN_COOKIE。请在 Settings → Secrets and variables → Actions 添加。');
    result.errors.push('missing JUEJIN_COOKIE');
    fs.writeFileSync('juejin-result.json', JSON.stringify(result, null, 2));
    await pushServerChan({
      title: '❌ 掘金签到：缺少 cookie',
      desp: 'Actions secret `JUEJIN_COOKIE` 未设置。',
      short: '缺少 cookie',
    });
    process.exitCode = 2;
    return;
  }

  const headers = buildHeaders(cookie);

  // 1) 登录态 + 基础信息
  const user = await call('/user_api/v1/user/get' + q + '&not_self=0', headers);
  if (!user.json || !user.json.data || !user.json.data.user_name) {
    const why = user.empty ? '空响应' : ('err_no=' + (user.json && user.json.err_no));
    log('::error::掘金登录态无效（' + why + '），cookie 已过期，请重新获取。');
    result.errors.push('auth failed: ' + why);
    fs.writeFileSync('juejin-result.json', JSON.stringify(result, null, 2));
    await pushServerChan({
      title: '❌ 掘金签到：cookie 失效',
      desp: '掘金 cookie 已失效，需要重新获取。\n\n获取方式：登录 juejin.cn → F12 → Network → 任意请求的 Cookie 头整行复制。',
      short: 'cookie 失效',
    });
    process.exitCode = 3;
    return;
  }
  result.userName = user.json.data.user_name;
  result.userId = user.json.data.user_id;
  log('[auth] 已登录: ' + result.userName + ' (uid=' + result.userId + ')');

  // 2) 今日状态
  const before = await call('/growth_api/v2/get_today_status' + q, headers);
  const doneBefore = !!(before.json && before.json.data && before.json.data.check_in_done);
  log('[status] 今日签到状态: ' + (doneBefore ? '已签到' : '未签到'));

  // 3) 签到（已签到则跳过，避免无谓请求）
  if (doneBefore) {
    result.steps.push({ task: 'check_in', skipped: 'already done today', done: true });
    log('[sign] 今日已签到，跳过');
  } else {
    let ok = false;
    let lastErr = '';
    for (let i = 0; i < 3; i++) {
      if (i > 0) { log('[sign] 重试 ' + i + '/2 ...'); await sleep(2000); }
      const r = await call('/growth_api/v1/check_in' + q, headers, 'POST');
      if (r.empty) { lastErr = '空响应（可能被风控）'; continue; }
      if (r.json && r.json.err_no === 0) {
        result.steps.push({ task: 'check_in', success: true, incr_point: r.json.data && r.json.data.incr_point, done: true });
        log('[sign] 签到成功，获得矿石 ' + (r.json.data && r.json.data.incr_point));
        ok = true;
        break;
      }
      lastErr = 'err_no=' + (r.json && r.json.err_no) + ' ' + (r.json && r.json.err_msg);
      log('[sign] 失败: ' + lastErr);
    }
    if (!ok) {
      result.errors.push('check_in failed: ' + lastErr);
      result.steps.push({ task: 'check_in', success: false, error: lastErr, done: false });
    }
    await sleep(1200);
  }

  // 4) 免费抽奖
  const draw = await call('/growth_api/v1/lottery/draw' + q, headers, 'POST');
  if (draw.empty) {
    result.steps.push({ task: 'lottery', success: false, note: '空响应（可能今日已抽完）', done: false });
    log('[lottery] 空响应，可能今日已抽过');
  } else if (draw.json && draw.json.err_no === 0) {
    const name = draw.json.data && draw.json.data.lottery_name;
    result.steps.push({ task: 'lottery', success: true, prize: name, done: true });
    log('[lottery] 中奖: ' + name + (String(name).indexOf('矿石') === -1 ? '  🎉' : ''));
  } else {
    const msg = (draw.json && draw.json.err_msg) || '未知';
    result.steps.push({ task: 'lottery', success: false, note: msg, done: false });
    log('[lottery] 未抽中或已抽完: ' + msg);
  }

  // 5) 汇总数据
  const counts = await call('/growth_api/v1/get_counts' + q, headers);
  if (counts.json && counts.json.data) {
    result.contCount = counts.json.data.cont_count;
    result.sumCount = counts.json.data.sum_count;
  }
  const point = await call('/growth_api/v1/get_cur_point' + q, headers);
  if (point.json && typeof point.json.data === 'number') result.point = point.json.data;
  log('[stats] 连签 ' + result.contCount + ' 天，累计 ' + result.sumCount + ' 天，矿石 ' + result.point);

  const doneSteps = result.steps.filter((s) => s.done);
  result.ok = doneSteps.length > 0 && result.errors.length === 0;
  log('\n===== 汇总 =====');
  log(JSON.stringify(result, null, 2));
  fs.writeFileSync('juejin-result.json', JSON.stringify(result, null, 2));

  // 6) 推送
  const signRow = result.steps.find((s) => s.task === 'check_in');
  const lotRow = result.steps.find((s) => s.task === 'lottery');
  const lines = [
    '**账号**：' + result.userName,
    '**矿石**：' + (result.point !== undefined ? result.point : '?') + '（连签 ' + (result.contCount ?? '?') + ' 天 / 累计 ' + (result.sumCount ?? '?') + ' 天）',
    '',
    '### 任务结果',
    signRow && signRow.skipped
      ? '- 签到：今日已签，跳过'
      : signRow && signRow.success
        ? '- 签到：成功，+' + signRow.incr_point + ' 矿石'
        : '- 签到：失败' + (signRow ? '（' + (signRow.error || '') + '）' : ''),
    lotRow && lotRow.success
      ? '- 抽奖：' + lotRow.prize
      : '- 抽奖：' + (lotRow ? (lotRow.note || '未中奖') : '未执行'),
    '',
    '运行时间：' + result.time.replace('T', ' ').replace('Z', ' UTC'),
  ];

  await pushServerChan({
    title: (result.ok ? '✅' : '⚠️') + ' 掘金签到' + (result.ok ? '完成' : '异常'),
    desp: lines.join('\n'),
    short: (lotRow && lotRow.success && String(lotRow.prize).indexOf('矿石') === -1 ? '中奖:' + lotRow.prize : '矿石' + (result.point ?? '?')),
  });

  if (!result.ok) process.exitCode = 4;
  else log('::notice::掘金签到完成');
}

main().catch((e) => {
  console.error('::error::' + e.message);
  process.exitCode = 1;
});
