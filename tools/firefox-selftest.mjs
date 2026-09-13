// Firefox 自测：用 geckodriver（WebDriver）在真实 chat.deepseek.com 上验证注入是否生效
//
// 前置：
//   1) 装 Firefox Developer Edition（要能关签名校验）
//   2) 下一个 geckodriver 并启动： geckodriver --port 4444
//   3) 造一个预装了本扩展的 profile，并把它压成 zip、转 base64：
//        <profile>/prefs.js                          （含 xpinstall.signatures.required=false）
//        <profile>/extensions/deepseek-tts-unlock@eyeing0721.xpi
//      再 PowerShll： [Convert]::ToBase64String([IO.File]::ReadAllBytes('profile.zip')) > profile.b64
//
// 跑：
//   node tools/firefox-selftest.mjs <profile.b64 路径> [firefox.exe 路径]
//
// 断言 4 项：主世界注入、读配置补 tts_feature、版本号抬高、写盘时减回去。
import fs from 'node:fs';

const WD = process.env.WD_URL || 'http://127.0.0.1:4444';
const profileB64Path = process.argv[2];
const FIREFOX = process.argv[3] || process.env.FF_BIN || 'C:\\Program Files\\Firefox Developer Edition\\firefox.exe';

if (!profileB64Path) {
  console.error('用法: node tools/firefox-selftest.mjs <profile.b64> [firefox.exe]');
  process.exit(2);
}
const profileB64 = fs.readFileSync(profileB64Path, 'utf8').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(WD + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const PROBE = `
return (() => {
  const KEY = '__ds_remote_feature_store_model';
  const out = { href: location.href };
  out.marker = document.documentElement.getAttribute('data-ds-tts-unlock');
  try {
    localStorage.removeItem(KEY);
    const fake = {
      entries: { model_configs: { value: [
        { model_type: 'deepseek-chat', enabled: true },
        { model_type: 'deepseek-reasoner', enabled: true }
      ] } },
      remoteVersion: 81
    };
    localStorage.setItem(KEY, JSON.stringify(fake));
    const read1 = JSON.parse(localStorage.getItem(KEY));   // 读：应补 tts_feature、81 -> 1081
    out.readVersion = read1.remoteVersion;
    out.ttsFlags = read1.entries.model_configs.value.map(m => JSON.stringify(m.tts_feature));
    localStorage.setItem(KEY, JSON.stringify({ ...read1, remoteVersion: 1081 }));
    out.roundTripVersion = JSON.parse(localStorage.getItem(KEY)).remoteVersion;  // 没减就是 2081
  } catch (e) { out.error = String(e); }
  return out;
})()
`;

(async () => {
  const sess = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        acceptInsecureCerts: true,
        'moz:firefoxOptions': {
          binary: FIREFOX,
          profile: profileB64,
          args: ['-headless'],
          prefs: {
            'xpinstall.signatures.required': false,
            'extensions.autoDisableScopes': 0,
            'extensions.enabledScopes': 15,
          },
        },
      },
    },
  });
  if (sess.status !== 200 || !sess.json?.value) {
    console.error('建会话失败：', sess.status, sess.text.slice(0, 800));
    process.exit(1);
  }
  const sid = sess.json.value.sessionId;
  console.log('session ok:', sid);

  try {
    await wd('POST', `/session/${sid}/url`, { url: 'https://chat.deepseek.com/' });
    await sleep(6000); // 等页面 + 内容脚本起来
    const ex = await wd('POST', `/session/${sid}/execute/sync`, { script: PROBE, args: [] });
    if (ex.status !== 200) {
      console.error('执行失败：', ex.status, ex.text.slice(0, 600));
      process.exitCode = 1;
      return;
    }
    const r = ex.json.value;
    const checks = [
      ['主世界注入 (data-ds-tts-unlock=1)', r.marker === '1', r.marker],
      ['读配置补 tts_feature', Array.isArray(r.ttsFlags) && r.ttsFlags.every((f) => f && f !== 'undefined' && f !== 'false'), r.ttsFlags],
      ['版本号抬高 81 -> 1081', r.readVersion === 1081, r.readVersion],
      ['写盘还原（读回仍 1081）', r.roundTripVersion === 1081, r.roundTripVersion],
    ];
    console.log('\nURL:', r.href);
    for (const [name, ok, val] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${JSON.stringify(val)}`);
    if (!checks.every((c) => c[1])) process.exitCode = 1;
  } finally {
    await wd('DELETE', `/session/${sid}`);
  }
})().catch((e) => { console.error('异常：', e); process.exit(1); });
