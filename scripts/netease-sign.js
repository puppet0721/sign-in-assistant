#!/usr/bin/env node
/**
 * 网易云音乐每日签到 / 云贝签到 / 听歌上报 — GitHub Actions 版
 *
 * 为什么不用仓库原版 signin/scripts/wangyi.py：
 *   它直接明文 POST JSON 到 /weapi/*，缺少 params + encSecKey 加密层，
 *   服务端返回空 body(HTTP 200, len=0)，json 解析必失败 → 误判 Cookie 失效。
 *   本脚本按网易云前端 asrsea 逻辑补齐 AES-128-CBC 双层 + RSA 裸模幂加密。
 *
 * 环境变量：
 *   MUSIC_U          必填，网易云 Cookie 里的 MUSIC_U 值（也接受完整 cookie 串）
 *   NETEASE_CSRF     可选，__csrf 值
 *   LISTEN_COUNT     可选，听歌上报条数，默认 0
 *   SERVERCHAN_KEY   可选，Server酱 SendKey，填了就推送微信
 */

const crypto = require('crypto');
const fs = require('fs');

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const PUB_N = BigInt('0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7');
const PUB_E = 0x10001n;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://music.163.com';

function aesEncrypt(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]).toString('base64');
}

function modPow(base, exp, mod) {
  let r = 1n, b = base % mod, e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

// 网易云前端 rsaEncrypt：文本字节反转 → hex → 裸 RSA → 补满 256 位 hex
function rsaEncrypt(text) {
  const reversed = Buffer.from([...Buffer.from(text, 'utf8')].reverse());
  const m = BigInt('0x' + (reversed.toString('hex') || '0'));
  return modPow(m, PUB_E, PUB_N).toString(16).padStart(256, '0');
}

function asrsea(obj) {
  const json = JSON.stringify(obj);
  const nonce = crypto.randomBytes(8).toString('hex').slice(0, 16);
  const first = aesEncrypt(json, PRESET_KEY);
  return { encText: aesEncrypt(first, nonce), encSecKey: rsaEncrypt(nonce) };
}

async function weapi(path, payload, cookie) {
  const { encText, encSecKey } = asrsea(payload);
  const body = new URLSearchParams({ params: encText, encSecKey }).toString();
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: BASE + '/',
      Origin: BASE,
      Cookie: cookie,
    },
    body,
  });
  const text = await res.text();
  if (!text) return { __http: res.status, __empty: true };
  try { return JSON.parse(text); } catch { return { __http: res.status, __raw: text.slice(0, 200) }; }
}

function buildCookie() {
  const raw = (process.env.MUSIC_U || '').trim();
  if (!raw) return '';
  if (raw.includes('=')) {
    let c = raw.replace(/^\s*cookie:\s*/i, '').trim();
    if (c.includes('MUSIC_U')) return c;
    return c + '; MUSIC_U=' + c.split('=').slice(1).join('=');
  }
  const csrf = (process.env.NETEASE_CSRF || '').trim();
  return 'MUSIC_U=' + raw + (csrf ? '; __csrf=' + csrf : '');
}

const log = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Server酱推送。失败只记日志，绝不影响签到本身的退出码。
 */
async function pushServerChan(payload) {
  const key = (process.env.SERVERCHAN_KEY || '').trim();
  if (!key) {
    log('[notify] 跳过：SERVERCHAN_KEY 未设置');
    return { skipped: 'no SERVERCHAN_KEY' };
  }
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
    log('[notify] Server酱 ' + (ok ? '已推送 pushid=' + (json.data && json.data.pushid || '?') : '失败 ' + JSON.stringify(json).slice(0, 120)));
    return { ok, json };
  } catch (e) {
    log('[notify] Server酱 请求异常: ' + e.message);
    return { ok: false, error: e.message };
  }
}

async function main() {
  const cookie = buildCookie();
  const listenCount = parseInt(process.env.LISTEN_COUNT || '0', 10) || 0;
  const result = { time: new Date().toISOString(), ok: false, steps: [], errors: [] };

  if (!cookie || !cookie.includes('MUSIC_U')) {
    log('::error::缺少 MUSIC_U。请在仓库 Settings → Secrets and variables → Actions 里添加 secret MUSIC_U。');
    result.errors.push('missing MUSIC_U');
    fs.writeFileSync('sign-result.json', JSON.stringify(result, null, 2));
    await pushServerChan({
      title: '❌ 网易云签到失败：缺少 MUSIC_U',
      desp: 'Actions secret `MUSIC_U` 未设置。',
      short: '缺少 MUSIC_U',
    });
    process.exitCode = 2;
    return;
  }

  // 1) 登录态
  const account = await weapi('/weapi/w/nuser/account/get', {}, cookie);
  if (account.code !== 200 || !account.profile) {
    const why = account.__empty ? '服务端返回空响应（加密未通过）' : 'code=' + account.code;
    log('::error::登录态无效（' + why + '），MUSIC_U 已过期，请更新 secret。');
    result.errors.push('auth failed: ' + why);
    fs.writeFileSync('sign-result.json', JSON.stringify(result, null, 2));
    await pushServerChan({
      title: '❌ 网易云签到失败：Cookie 失效',
      desp: 'MUSIC_U 登录态无效（' + why + '）。\n\n请更新 Actions secret `MUSIC_U`。',
      short: 'MUSIC_U 已过期',
    });
    process.exitCode = 3;
    return;
  }
  result.nickname = account.profile.nickname;
  result.uid = account.profile.userId;
  log('[auth] 已登录: ' + result.nickname + ' (uid=' + result.uid + ')');

  const levelInfo = await weapi('/weapi/user/level', {}, cookie);
  const level = levelInfo?.data?.level ?? 0;
  result.level = level;
  result.nowPlayCount = levelInfo?.data?.nowPlayCount ?? null;
  log('[level] 等级 ' + level + '，累计听歌 ' + result.nowPlayCount);

  // 2) 每日签到(type=0) + 云贝签到(type=1)
  //    已知返回：code=200 成功 / -2 重复签到（今天已签） / 403 请稍后再试（频率限制）
  for (const [label, type] of [['daily_signin', 0], ['yunbei_sign', 1]]) {
    let r;
    let attempt = 0;
    for (let i = 0; i < 3; i++) {
      attempt = i + 1;
      r = await weapi('/weapi/point/dailyTask', { type }, cookie);
      // 403 / -460 属于限流，退避后重试；200 与 -2 是终态
      if (r.code === 403 || r.code === -460) {
        const wait = 3000 + i * 4000;
        log('[' + label + '] code=' + r.code + '（' + (r.message || r.msg || '限流') + '），' + (wait / 1000) + 's 后重试 ' + (i + 1) + '/3');
        await sleep(wait);
        continue;
      }
      break;
    }
    const msg = r.message || r.msg || '';
    // 重要：code=200 只代表"请求被受理"，不代表签到成功。
    // 网易云对 type=0 会返回 {code:200, message:"功能暂不支持"}，此时并未签到。
    const notSupported = /功能暂不支持|暂不支持|not\s*support/i.test(msg);
    const row = {
      task: label,
      type,
      code: r.code,
      point: r.point ?? null,
      msg,
      attempt,
      notSupported,
      // 只有真正签上（200 且不是"功能暂不支持"）或今日已签（-2）才算完成
      done: !notSupported && (r.code === 200 || r.code === -2),
    };
    result.steps.push(row);
    const tag = row.notSupported ? '  ⊘ 接口已下线' : row.done ? '' : '  ⚠ 未完成';
    log('[' + label + '] code=' + row.code + (row.point !== null ? ' point=' + row.point : '') + (msg ? ' msg=' + msg : '') + tag);
    await sleep(900 + Math.random() * 800);
  }

  // 3) 听歌上报（走 feedback/weblog，不是 404 的 play/song/record）
  //    歌曲来源：热歌榜歌单（playlist/detail），因为 recommend/songs 对部分账号返回空
  if (listenCount > 0) {
    if (level >= 10) {
      log('[listen] 等级已满 10 级，跳过');
      result.steps.push({ task: 'listen_songs', skipped: 'level>=10' });
    } else {
      const PLAYLIST_ID = parseInt(process.env.LISTEN_PLAYLIST_ID || '3778678', 10) || 3778678;
      const pl = await weapi('/weapi/v3/playlist/detail', { id: PLAYLIST_ID, n: 1000 }, cookie);
      const tracks = (pl?.playlist?.tracks || []).filter((t) => t && t.id);
      log('[listen] 歌单 ' + (pl?.playlist?.name || PLAYLIST_ID) + ' 取到 ' + tracks.length + ' 首，目标上报 ' + listenCount + ' 首');
      if (!tracks.length) {
        log('[listen] 歌单为空，跳过');
        result.steps.push({ task: 'listen_songs', reported: 0, target: 0, reason: 'playlist empty' });
      }
      let ok = 0;
      for (const t of tracks) {
        if (ok >= listenCount) break;
        const logs = [{ action: 'play', json: { id: t.id, type: 'song', vs: '0' }, time: Date.now() }];
        const r = await weapi('/weapi/feedback/weblog', { logs: JSON.stringify(logs) }, cookie);
        if (r.code === 200) {
          ok += 1;
          if (ok % 10 === 0) log('[listen] 已上报 ' + ok + ' 首');
        }
        await sleep(400 + Math.random() * 600);
      }
      result.steps.push({ task: 'listen_songs', reported: ok, target: listenCount });
      log('[listen] 上报完成 ' + ok + '/' + listenCount + ' 首');
    }
  }

  const okSteps = result.steps.filter((s) => s.done || s.reported > 0 || s.skipped);
  result.ok = okSteps.length > 0 && result.errors.length === 0;
  log('\n===== 汇总 =====');
  log(JSON.stringify(result, null, 2));

  fs.writeFileSync('sign-result.json', JSON.stringify(result, null, 2));

  // 汇总文本（给推送用）
  const signLabel = (s) => {
    if (s.notSupported) return '接口已下线（功能暂不支持）';
    if (s.code === -2) return '今日已签';
    if (s.code === 200) return s.point !== null ? '成功，+' + s.point : '成功';
    return '失败 ' + s.code + (s.msg ? '（' + s.msg + '）' : '');
  };
  const lines = result.steps.map((s) => {
    if (s.task === 'daily_signin') return '- 每日签到：' + signLabel(s);
    if (s.task === 'yunbei_sign') {
      const extra = !s.notSupported && s.code === 200 && s.point !== null ? '，+' + s.point + ' 云贝' : '';
      return '- 云贝签到：' + signLabel(s) + extra;
    }
    if (s.task === 'listen_songs') return s.skipped ? '- 听歌：跳过（等级已满 10 级）' : '- 听歌：上报 ' + s.reported + '/' + s.target + ' 首';
    return '- ' + JSON.stringify(s);
  });
  // 是否真的签到了（排除"功能暂不支持"）
  const realSigned = result.steps.some((s) => !s.notSupported && (s.code === 200 || s.code === -2));
  const desp = [
    '**账号**：' + result.nickname + '（uid ' + result.uid + '）',
    '**等级**：Lv.' + result.level + '，累计听歌 ' + result.nowPlayCount,
    '',
    '### 任务结果',
    ...lines,
    realSigned ? '' : '⚠️ 本次没有实际签到成功，请检查接口状态',
    '',
    '运行时间：' + result.time.replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC'),
  ].filter((x) => x !== null).join('\n');

  const title = !realSigned
    ? '⚠️ 网易云签到：未签上'
    : (result.ok ? '✅ 网易云签到完成' : '⚠️ 网易云签到异常');
  await pushServerChan({
    title,
    desp,
    short: result.steps.map((s) => s.task.replace('_signin', '').replace('_sign', '').replace('_songs', '') + ':' + (s.notSupported ? 'off' : s.done ? 'ok' : s.reported !== undefined ? s.reported : 'no')).join(' ').slice(0, 64),
  });

  if (!result.ok) process.exitCode = 4;
  else log('::notice::网易云签到完成');
}

main().catch((e) => {
  console.error('::error::' + e.message);
  process.exitCode = 1;
});
