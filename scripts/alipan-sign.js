#!/usr/bin/env node
/**
 * 阿里云盘每日签到 — GitHub Actions 版
 *
 * 为什么不用仓库原版 signin/scripts/aliyundrive.py：
 *   实测该文件 4 个端点里有 3 个已不存在（404），另外还有判断条件写错，详见 README。
 *   本脚本用实测可用的端点重写。
 *
 * 实测可用的调用链（2026-11 验证）：
 *   1) POST https://auth.alipan.com/v2/account/token
 *      {"grant_type":"refresh_token","refresh_token":"..."}  → access_token / refresh_token / expires_in
 *   2) POST https://member.alipan.com/v1/activity/sign_in_list
 *      Authorization: Bearer <access_token>  {"isReward":false}  → 这一步即完成签到
 *   3) POST https://member.alipan.com/v1/activity/sign_in_reward  → 403 请升级最新客户端访问（网页端已禁用，跳过）
 *
 * 环境变量：
 *   ALIPAN_REFRESH_TOKEN   必填，阿里云盘 refresh_token
 *   SERVERCHAN_KEY         可选，Server酱 SendKey
 */

const fs = require('fs');

const TOKEN_URL = 'https://auth.alipan.com/v2/account/token';
const SIGNIN_URL = 'https://member.alipan.com/v1/activity/sign_in_list';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const log = (s) => console.log(s);

async function api(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { __raw: text.slice(0, 200) }; }
  return { http: res.status, json };
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
    const { http, json } = await api('https://sctapi.ftqq.com/' + key + '.send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const ok = json && json.code === 0;
    log('[notify] Server酱 ' + (ok ? '已推送 pushid=' + (json.data && json.data.pushid || '?') : '失败 http=' + http));
    return { ok };
  } catch (e) {
    log('[notify] Server酱 异常: ' + e.message);
    return { ok: false };
  }
}

async function main() {
  const refreshToken = (process.env.ALIPAN_REFRESH_TOKEN || '').trim();
  const result = { platform: 'aliyunpan', time: new Date().toISOString(), ok: false, steps: [], errors: [] };

  if (!refreshToken) {
    log('::error::缺少 ALIPAN_REFRESH_TOKEN。请在 Settings → Secrets and variables → Actions 添加。');
    result.errors.push('missing ALIPAN_REFRESH_TOKEN');
    fs.writeFileSync('alipan-result.json', JSON.stringify(result, null, 2));
    await pushServerChan({
      title: '❌ 阿里云盘签到：缺少 token',
      desp: 'Actions secret `ALIPAN_REFRESH_TOKEN` 未设置。',
      short: '缺少 refresh_token',
    });
    process.exitCode = 2;
    return;
  }

  // 1) 刷新 access_token
  log('[auth] 刷新 access_token...');
  const t = await api(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });

  const accessToken = t.json && t.json.access_token;
  if (!accessToken) {
    const code = (t.json && t.json.code) || '';
    log('::error::refresh_token 无效（http=' + t.http + (code ? ' code=' + code : '') + '），请重新获取。');
    result.errors.push('token invalid: ' + (code || t.http));
    fs.writeFileSync('alipan-result.json', JSON.stringify(result, null, 2));
    await pushServerChan({
      title: '❌ 阿里云盘签到：token 失效',
      desp: 'refresh_token 已失效，需要重新获取。\n\n获取方式：登录 www.alipan.com → F12 Console → `JSON.parse(localStorage.getItem(\'token\')).refresh_token`',
      short: 'refresh_token 失效',
    });
    process.exitCode = 3;
    return;
  }

  // 阿里云盘的 refresh_token 每次刷新都会换新的；旧 token 实测可重复使用，
  // 所以这里只提示，不尝试回写（Actions 无法写回 Secret）。
  const newRefresh = t.json.refresh_token;
  if (newRefresh && newRefresh !== refreshToken) {
    log('[auth] refresh_token 已轮换为 ' + newRefresh.slice(0, 6) + '...' + newRefresh.slice(-4) + '（旧 token 仍可用，无需更新 Secret）');
  }
  result.tokenRotated = !!(newRefresh && newRefresh !== refreshToken);
  log('[auth] access_token 已获取，有效期 ' + (t.json.expires_in || '?') + ' 秒');

  // 2) 签到（这个接口本身就是签到动作）
  log('[sign] 执行每日签到...');
  const s = await api(SIGNIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken,
      'User-Agent': UA,
    },
    body: JSON.stringify({ isReward: false }),
  });

  const j = s.json || {};
  if (j.success && j.result) {
    const logs = j.result.signInLogs || [];
    const today = logs[0] || {};
    const row = {
      task: 'sign_in',
      success: true,
      activity: j.result.title || null,
      signInCount: j.result.signInCount,
      todayDay: today.day,
      todayStatus: today.status,
      done: true,
    };
    result.steps.push(row);
    log('[sign] 签到成功：' + row.activity + '，本月已签 ' + row.signInCount + ' 天');
  } else {
    const code = j.code || '';
    const msg = j.message || '';
    result.errors.push('sign failed: ' + (code || s.http) + ' ' + msg);
    result.steps.push({ task: 'sign_in', success: false, code, msg, done: false });
    log('::error::签到失败 http=' + s.http + ' code=' + code + ' msg=' + msg);
  }

  // 3) 领奖尝试（已知网页端被禁用，仅记录不报错）
  const day = (result.steps[0] && result.steps[0].todayDay) || 1;
  const rw = await api('https://member.alipan.com/v1/activity/sign_in_reward', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + accessToken,
      'User-Agent': UA,
    },
    body: JSON.stringify({ signInDay: day }),
  });
  const rwj = rw.json || {};
  result.steps.push({
    task: 'claim_reward',
    success: !!rwj.success,
    http: rw.http,
    code: rwj.code || null,
    note: rwj.success ? (rwj.result && rwj.result.notice) || '已领取' : (rwj.message || '未领取'),
    done: !!rwj.success,
  });
  if (rwj.success) {
    log('[reward] 奖励已领取：' + ((rwj.result && rwj.result.notice) || ''));
  } else {
    log('[reward] 领奖跳过（' + (rwj.code || rw.http) + ' ' + (rwj.message || '') + '）— 网页端领奖已被官方禁用，只能签到');
  }

  result.ok = result.steps.some((x) => x.done) && result.errors.length === 0;
  log('\n===== 汇总 =====');
  log(JSON.stringify(result, null, 2));
  fs.writeFileSync('alipan-result.json', JSON.stringify(result, null, 2));

  // 推送
  const signRow = result.steps.find((x) => x.task === 'sign_in');
  const rwRow = result.steps.find((x) => x.task === 'claim_reward');
  const desps = [
    '**账号**：' + ((result.userInfo && result.userInfo.nick) || '阿里云盘'),
    '',
    '### 任务结果',
    signRow && signRow.success
      ? '- 签到：成功（' + signRow.activity + '），本月已签 ' + signRow.signInCount + ' 天'
      : '- 签到：失败（' + (signRow ? (signRow.code || '') : '') + '）',
    rwRow && rwRow.success
      ? '- 领奖：' + rwRow.note
      : '- 领奖：跳过（网页端已被官方禁用）',
    '',
    '运行时间：' + result.time.replace('T', ' ').replace('Z', ' UTC'),
  ];

  await pushServerChan({
    title: (result.ok ? '✅' : '⚠️') + ' 阿里云盘签到' + (result.ok ? '完成' : '异常'),
    desp: desps.join('\n'),
    short: signRow && signRow.success ? '已签' + signRow.signInCount + '天' : '签到失败',
  });

  if (!result.ok) process.exitCode = 4;
  else log('::notice::阿里云盘签到完成');
}

main().catch((e) => {
  console.error('::error::' + e.message);
  process.exitCode = 1;
});
