/* ============================================================================
 * DeepSeek 网页版「朗读 / TTS」灰测解锁 + 接口探针
 * ----------------------------------------------------------------------------
 * 依据：2026-09-12 线上产物
 *   https://fe-static.deepseek.com/chat/static/main.d69e3d8c16.js   (commit-id 5d128f98)
 *   https://fe-static.deepseek.com/chat/static/web-tts.d93cb232e3.js (懒加载 chunk 74268)
 *
 * 结论速览（细节见文件末尾「协议备忘」）：
 *   1) 网页版有没有「朗读」按钮，取决于客户端缓存的远程配置：
 *        localStorage["__ds_remote_feature_store_model"].entries.model_configs.value[].tts_feature
 *      渲染判断就一句：ct().find(e => e.model_type === 当前模型)?.tts_feature 为真才出按钮。
 *      这是纯客户端开关 —— 所以「没灰度到」也能靠改这份缓存把入口挤出来（A / C 段）。
 *   2) 真正出声走的是 WebSocket，不是 HTTP：
 *        POST /api/v0/auth/ticket  {scope:"tts"}      -> biz_data.ticket
 *        wss://chat.deepseek.com/api/v0/chat/tts/?chat_session_id=..&message_id=..&ticket=..&mode=manual&format=opus|pcm
 *      语音列表 / 切音色：GET /api/v0/chat/tts/voices、POST /api/v0/chat/tts/voice {voice_id}
 *   3) 【2026-09-12 已实测】后端不卡灰度：
 *      - 实测账号 model_configs 里 tts_feature 全是 false（确实没被灰度到），
 *        但 GET /api/v0/chat/tts/voices 与 POST /api/v0/auth/ticket {scope:"tts"} 都返回 biz_code=0；
 *      - 直接走 wss 合成成功：pcm 26 帧 / 124426 字节（2.59s，24kHz 单声道 s16le，voice_id=mira），
 *        opus 24 帧 / 7351 字节，ready 事件里带 voice_id 与 trace_id；
 *      - 切音色 POST /api/v0/chat/tts/voice 生效（tide 合成 30 帧 / 142080 字节），切回 mira 正常。
 *      结论：灰度只落在「前端配置 + 那个按钮」上，接口对普通登录账号就是开的。
 *      服务端仍可能对封禁/地区账号返回 biz_code=9(NOT_AVAILABLE)/11(FORBIDDEN)，D 段一跑就知道。
 *   4) 两个实测细节：ticket 是一次性的（600s 有效期内也只能用一次），每次建连前都要重新取；
 *      format=opus 与 format=pcm 服务端都支持，pcm 能直接灌 WebAudio，opus 要解码器。
 *
 * 用法：整段粘贴进 Edge/Chrome 的 DevTools Console（需在已登录的 chat.deepseek.com 标签页），
 *      然后调用 dsTtsUnlock() / dsTtsProbe() / dsTtsRead()。油猴版见 C 段。
 * ==========================================================================*/

/* ---------------------------------------------------------------------------
 * A. 一键把「朗读」入口开出来（免刷新版：改完调用 location.reload()）
 *    原理：客户端只在 remoteVersion 变大时才接受服务端新配置，
 *          把 remoteVersion 抬到 999999 就能让这份手改的缓存不被覆盖。
 * -------------------------------------------------------------------------*/
function dsTtsUnlock() {
  const KEY = '__ds_remote_feature_store_model';
  const raw = localStorage.getItem(KEY);
  if (!raw) return console.error('[ds-tts] 没找到配置缓存，先登录并刷新一次 chat.deepseek.com');
  const store = JSON.parse(raw);
  const list = store?.entries?.model_configs?.value;
  if (!Array.isArray(list)) return console.error('[ds-tts] 缓存结构不符（可能前端改版了），键：' + KEY);
  let n = 0;
  for (const cfg of list) {
    if (cfg && cfg.enabled && !cfg.tts_feature) { cfg.tts_feature = {}; n++; }
  }
  store.remoteVersion = 999999;
  localStorage.setItem(KEY, JSON.stringify(store));
  console.log(`[ds-tts] 已给 ${n} 个模型打开 tts_feature，刷新页面后每条回答下面就会出现「朗读」。`);
  console.log('[ds-tts] 副作用：remoteVersion 被顶高后，官方后续下发的模型/配置更新将不再生效。');
  return n;
}

/* 还原（同时清掉那份被顶高的缓存，让服务端重新下发） */
function dsTtsRelock() {
  localStorage.removeItem('__ds_remote_feature_store_model');
  console.log('[ds-tts] 已恢复默认，刷新页面生效。');
}

/* ---------------------------------------------------------------------------
 * B. 只想看现在到底有没有被灰度到
 * -------------------------------------------------------------------------*/
function dsTtsStatus() {
  const store = JSON.parse(localStorage.getItem('__ds_remote_feature_store_model') || 'null');
  const list = store?.entries?.model_configs?.value || [];
  console.table(list.filter(c => c && c.enabled).map(c => ({
    model: c.model_type,
    tts_feature: c.tts_feature ? JSON.stringify(c.tts_feature) : '(无 → 未灰度)',
  })));
  console.log('[ds-tts] remoteVersion =', store?.remoteVersion);
}

/* ---------------------------------------------------------------------------
 * C. 油猴脚本版（推荐，不会被服务端配置覆盖，也不用顶 remoteVersion）
 *    新建脚本 → @run-at document-start → 粘贴下面 IIFE 的内容。
 * -------------------------------------------------------------------------*/
/*
// ==UserScript==
// @name         DeepSeek 朗读灰测解锁
// @namespace    local
// @match        https://chat.deepseek.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  const KEY = '__ds_remote_feature_store_model';
  const orig = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) {
    const v = orig.call(this, k);
    if (k !== KEY || !v) return v;
    try {
      const s = JSON.parse(v);
      const list = s?.entries?.model_configs?.value;
      if (Array.isArray(list)) {
        let dirty = false;
        for (const c of list) if (c && c.enabled && !c.tts_feature) { c.tts_feature = { forced: 1 }; dirty = true; }
        if (dirty) return JSON.stringify(s);   // 只在读的时候“造假”，磁盘上仍是官方原值
      }
    } catch {}
    return v;
  };
})();
*/

/* ---------------------------------------------------------------------------
 * D. 后端探针：换台机器/换个账号，判定服务端到底放不放行
 *    （这是「没灰度到能不能用」的最终答案，A 段只解决按钮）
 * -------------------------------------------------------------------------*/
async function dsTtsProbe() {
  const token = dsToken();
  if (!token) return console.error('[ds-tts] 没拿到登录态（localStorage.userToken 不存在）');
  const api = (path, init = {}) => fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  }).then(r => r.json());

  const voices = await api('/api/v0/chat/tts/voices');
  console.log('[ds-tts] 1) 音色列表 GET /api/v0/chat/tts/voices =>', voices);

  const ticket = await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) });
  console.log('[ds-tts] 2) 取票 POST /api/v0/auth/ticket {scope:"tts"} =>', ticket);
  const code = ticket?.data?.biz_code;
  if (ticket?.code === 0 && code === 0) {
    console.log('%c[ds-tts] ✅ 服务端放行，ticket = ' + ticket.data.biz_data.ticket, 'color:green');
  } else {
    console.log('%c[ds-tts] ❌ 服务端没放行，biz_code = ' + code + ' / ' + ticket?.data?.biz_msg +
      '（9=NOT_AVAILABLE 10=RESUME_EXPIRED 11=FORBIDDEN）', 'color:crimson');
  }
  return { voices, ticket };
}

function dsToken() {
  try { return JSON.parse(localStorage.getItem('userToken') || 'null')?.value || null; } catch { return null; }
}

/* ---------------------------------------------------------------------------
 * E. 完整朗读播放器：绕开 UI，直接走 wss 把某条回答读出来
 *    dsTtsRead() 默认读当前会话最后一条有正文的消息；也可 dsTtsRead({messageId})
 *    默认 format:'pcm'（24kHz 单声道 s16le，浏览器直接播）；
 *    客户端自己默认用 'opus'，解码器加载失败才回退 pcm —— pcm 这条路是官方代码里写死的。
 * -------------------------------------------------------------------------*/
async function dsTtsRead(opts = {}) {
  const token = dsToken();
  if (!token) throw new Error('未登录：localStorage.userToken 为空');
  const api = (path, init = {}) => fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  }).then(r => r.json());

  const sessionId = opts.sessionId || (location.pathname.match(/\/a\/chat\/s\/([0-9a-f-]{8,})/i) || [])[1];
  if (!sessionId) throw new Error('拿不到会话 id（请打开某个具体对话，URL 形如 /a/chat/s/<uuid>）');

  let messageId = opts.messageId;
  if (!messageId) {
    const h = await api('/api/v0/chat/history_messages?chat_session_id=' + sessionId);
    const msgs = h?.data?.biz_data?.chat_messages || [];
    const last = msgs.filter(m => m && m.content).pop();
    if (!last) throw new Error('这个会话里没找到可朗读的消息');
    messageId = last.message_id;
  }

  // 1) 取票
  const t = await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) });
  if (t?.code !== 0 || t?.data?.biz_code !== 0) {
    throw new Error('取票失败：' + JSON.stringify(t) + '（biz_code 9/11 表示服务端未对该账号放行）');
  }
  const ticket = t.data.biz_data.ticket;

  // 2) 开 ws（浏览器不能给 WebSocket 加 Authorization 头，所以票据走 query）
  const format = opts.format || 'pcm';
  const qs = new URLSearchParams({
    chat_session_id: sessionId,
    message_id: String(messageId),
    ticket,
    mode: 'manual',
    format,
  });
  const ws = new WebSocket(`wss://${location.host}/api/v0/chat/tts/?${qs}`);
  ws.binaryType = 'arraybuffer';

  const frames = new Map();      // seq -> payload，按 seq 去重
  let realFormat = format;
  console.log('[ds-tts] 已连接，等待音频…');

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 90000);
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        console.log('[ds-tts] ctrl', m);
        if (m.event === 'ready') {
          realFormat = m.format || realFormat;
          ws.send(JSON.stringify({ event: 'ack', received_seq: 0, played_seq: 0 }));
        }
        if (m.event === 'finish') { clearTimeout(timer); try { ws.close(); } catch {} resolve(); }
        return;
      }
      const dv = new DataView(ev.data);
      const seq = dv.getUint32(0, false);                  // 4 字节大端序号
      frames.set(seq, new Uint8Array(ev.data, 4));         // 其后是负载
      ws.send(JSON.stringify({ event: 'ack', received_seq: seq, played_seq: seq }));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')); };
    ws.onclose = () => { clearTimeout(timer); resolve(); };
  });

  const seqs = [...frames.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const s of seqs) total += frames.get(s).length;
  console.log(`[ds-tts] 收到 ${seqs.length} 帧 / ${total} 字节，format=${realFormat}`);
  if (!total) throw new Error('没收到音频数据（服务端拒绝或该消息无正文）');

  const buf = new Uint8Array(total);
  let off = 0;
  for (const s of seqs) { buf.set(frames.get(s), off); off += frames.get(s).length; }

  if (realFormat !== 'pcm') {
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/ogg' }));
    console.warn('[ds-tts] 服务端给的是 opus 裸包，浏览器不能直接播。已下载原始数据，可另存后用 ffmpeg 解码。');
    const a = document.createElement('a'); a.href = url; a.download = `ds-tts-${messageId}.opus`; a.click();
    return { format: realFormat, bytes: total, blob: url };
  }

  // 3) pcm = 24kHz 单声道 s16le，直接灌进 WebAudio
  const pcm = new Int16Array(buf.buffer, 0, buf.length >> 1);
  const ctx = new AudioContext({ sampleRate: 24000 });
  const ab = ctx.createBuffer(1, pcm.length, 24000);
  const ch = ab.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = ab; src.connect(ctx.destination); src.start();
  console.log('[ds-tts] ▶ 播放 ' + (pcm.length / 24000).toFixed(1) + ' 秒');
  return { format: realFormat, bytes: total, seconds: pcm.length / 24000, node: src };
}

/* ---------------------------------------------------------------------------
 * 协议备忘（2026-09-12 逆向自线上产物 + 实测校准）
 * ---------------------------------------------------------------------------
 * 配置门（客户端）：scope "model" 的远程配置，缓存键 __ds_remote_feature_store_model
 *   state = { schemaVersion:2, entries, timestamp, remoteVersion }
 *   —— loadEntries() 在 remoteVersion 变小时直接丢弃服务端数据，这就是 A 段生效的原因。
 *   getValue(key) => entries[key].value，所以模型开关路径是 entries.model_configs.value[].tts_feature。
 *   另：设置面板里「朗读音色」那一栏的显示条件同样是 ct().some(e => !!e.tts_feature)。
 *   实测账号 remoteVersion=81，三个模型 default/expert/vision 的 tts_feature 均为 false。
 *
 * 取票：POST /api/v0/auth/ticket  {"scope":"tts"}  需 Authorization: Bearer <userToken>
 *   实测返回 {"code":0,"data":{"biz_code":0,"biz_msg":"","biz_data":{"ticket":"<uuid>","expires_in_secs":600}}}
 *   ★ ticket 是一次性的：拿票合成一次成功，同一张票再用一次 ws 直接 1006 断开、零帧。
 *     前端每轮连接前都重新 issueTicket(signal, 3)，我们照做即可。
 *   ★ userToken 是 64 字符的不透明串（不是 JWT），存 localStorage.userToken 的 {"value":...}。
 *
 * 音色：GET  /api/v0/chat/tts/voices
 *         -> biz_data.voices[].voice_id / name_i18n / description_i18n / gender / languages /
 *            demo_urls / color_palette / is_default，外加 default_voice_id、current_voice_id
 *       POST /api/v0/chat/tts/voice  {"voice_id":"..."}  -> biz_data.biz_code（0=成功，1=音色下线，2=参数错）
 *       实测四音色 voice_id 对照（别猜，就是这个）：
 *         mira  = 贝壳 女 百变活泼 Versatile & Playful   默认
 *         echo  = 白浪 男 明朗坚定 Bright & Confident
 *         stella= 海星 女 俏皮甜美 Sweet & Lively
 *         tide  = 暗潮 男 低沉浑厚 Deep & Rich
 *       mira/echo 支持 29 种语言，stella/tide 只支持 ar/en/id/ja/ko/ms/th/vi/yue/zh
 *       （「当前语言暂不支持朗读」就是语言表没覆盖）；
 *       demo_urls[lang] 是公开 CDN 的 mp3，不带 token 也能下：
 *       https://cdn.deepseek.com/chat/tts/voice-demos/<voice>_<lang>.<hash>.mp3
 *
 * 合成（WebSocket）：
 *   wss://chat.deepseek.com/api/v0/chat/tts/
 *     ?chat_session_id=<会话id>&message_id=<消息id>&ticket=<票>&mode=manual&format=opus|pcm
 *   断线续传再补 audio_id / received_seq / played_seq。
 *   服务端文本帧（实测）：
 *     {"event":"ready","audio_id":"<uuid>","format":"pcm","voice_id":"mira","trace_id":"..."}
 *     {"event":"finish","code":0,"msg":"success"}
 *   服务端二进制帧：前 4 字节大端 seq + 负载（opus 包，或 24kHz 单声道 s16le）
 *   客户端文本帧：{"event":"ack","received_seq":n,"played_seq":n} / {"event":"abort","reason":..} / {"event":"finish"}
 *   实测数据：同一句 14 字中文 → pcm 26 帧 = 124426B = 2.59s；opus 24 帧 = 7351B；
 *             换成 tide 同句 → pcm 30 帧 = 142080B。两者都直接可播/可解码。
 *   错误码：0 SUCCESS / 1 INTERNAL_ERROR / 2 INVALID_INPUT / 3 SERVICE_ERROR / 4 QUOTA_EXCEEDED /
 *           5 RATE_LIMIT_REACHED / 6 NO_CONTENT / 7 UNSUPPORTED_LANGUAGE / 8 VOICE_UNSUPPORTED_LANGUAGE /
 *           9 NOT_AVAILABLE / 10 RESUME_EXPIRED / 11 FORBIDDEN / 12 CONTENT_FILTER
 *           对应前端提示：朗读已达今日限额 / 操作过于频繁 / 当前语言暂不支持朗读 / 该音色已下线 …
 *
 * 重要限制：请求里只有 chat_session_id + message_id，没有正文。
 *   也就是「读哪段文字」是服务端从你自己的会话消息里取的 —— 想让它读任意文本，
 *   得先把那段文字变成会话里的一条消息。另外 mode 恒定 "manual"（网页端没有 App 的语音对话）。
 * ==========================================================================*/

