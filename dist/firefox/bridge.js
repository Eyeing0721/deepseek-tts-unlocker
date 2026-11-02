/* DeepSeek 朗读解锁 —— 隔离世界脚本：给弹窗当后端，并做接口直连
 *
 * 它能读到本页 localStorage（同源共享）里的 userToken，所以可以在页面上下文里
 * 直接调官方接口：音色列表 / 切音色 / 历史消息 / 取 TTS 票据 / 合成音频（导出 WAV）。
 */

const KEY = '__ds_remote_feature_store_model';
const SAMPLE_RATE = 24000;
const BRIDGE_VERSION = 6;

function token() {
  try { return JSON.parse(localStorage.getItem('userToken') || 'null')?.value || null; } catch { return null; }
}

// 磁盘上的真实配置：用来告诉用户「你本来有没有被灰度到」
function grayInfo() {
  try {
    const store = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!store) return null;
    const list = (store.entries && store.entries.model_configs && store.entries.model_configs.value) || [];
    return {
      remoteVersion: store.remoteVersion ?? null,
      models: list.map(c => ({ model: c.model_type, enabled: !!c.enabled, gray: !!c.tts_feature })),
    };
  } catch { return null; }
}

async function api(path, init = {}, tk) {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(tk ? { Authorization: 'Bearer ' + tk } : {}),
      ...(init.headers || {}),
    },
  });
  return res.json();
}

function sessionIdFromUrl() {
  const m = location.pathname.match(/\/a\/chat\/s\/([^/?#]+)/i);
  return m ? m[1] : null;
}

function messageText(m) {
  if (!m) return '';
  // 当前接口把正文放在 fragments[].content（type: REQUEST / RESPONSE / THINK）
  if (Array.isArray(m.fragments)) {
    const parts = m.fragments.filter((f) => f && typeof f.content === 'string' && f.content);
    const visible = parts.filter((f) => !/^think/i.test(String(f.type || '')));
    const text = (visible.length ? visible : parts).map((f) => f.content).join('\n').trim();
    if (text) return text;
  }
  const content = m.content;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    for (const key of ['text', 'content', 'value', 'answer']) {
      if (typeof content[key] === 'string') return content[key];
    }
    if (Array.isArray(content)) {
      return content.map((x) => (typeof x === 'string' ? x : (x && typeof x.text === 'string' ? x.text : ''))).join(' ');
    }
  }
  return typeof m.text === 'string' ? m.text : '';
}

function messageRole(m) {
  const raw = m && (m.role || m.message_role || m.sender || m.role_type || m.type);
  if (raw == null) return '';
  const value = String(raw).toLowerCase();
  if (value === 'user' || value === 'human') return 'user';
  if (value === 'assistant' || value === 'ai' || value === 'bot') return 'assistant';
  return '';
}

function mapMessageList(list) {
  return (Array.isArray(list) ? list : [])
    .map((m) => m && { m, id: m.message_id != null ? m.message_id : m.id })
    .filter((x) => x && x.id != null)
    .slice(-400)
    .map(({ m, id }) => {
      const text = messageText(m).replace(/\s+/g, ' ').trim();
      return {
        id: String(id),
        role: messageRole(m),
        preview: text.slice(0, 80) || ('#' + String(id).slice(0, 8)),
      };
    });
}

// 页面主世界（inject.js）会把官方前端自己拉到的 history_messages 转过来
let pageMessages = null;

window.addEventListener('message', (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (data && data.__dsTtsUnlock === 'messages' && Array.isArray(data.messages)) {
    pageMessages = { sessionId: data.sessionId || null, messages: data.messages };
  }
});

function requestPageMessages() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      resolve(value || null);
    };
    const handler = (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (data && data.__dsTtsUnlock === 'messages' && Array.isArray(data.messages)) {
        finish({ sessionId: data.sessionId || null, messages: data.messages });
      }
    };
    const timer = setTimeout(() => finish(pageMessages), 700);
    window.addEventListener('message', handler);
    window.postMessage({ __dsTtsUnlock: 'getMessages' }, '*');
  });
}

function ack(ws, seq) {
  try {
    ws.send(JSON.stringify({ event: 'ack', received_seq: seq, played_seq: seq }));
  } catch { /* socket 已关 */ }
}

class TtsError extends Error {
  constructor(code, message) {
    super(message || ('tts error ' + code));
    this.code = code;
  }
}

// 官方朗读用的是同一条 wss；这里按 seq 收集二进制帧，攒成完整 PCM
function synthesizePcm(sessionId, messageId, ticket) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      chat_session_id: sessionId,
      message_id: String(messageId),
      ticket,
      mode: 'manual',
      format: 'pcm',
    });
    const ws = new WebSocket(`wss://${location.host}/api/v0/chat/tts/?${qs}`);
    ws.binaryType = 'arraybuffer';

    const frames = new Map();
    let realFormat = 'pcm';
    let settled = false;
    let sawFinish = false;
    let lastActivity = Date.now();
    const startedAt = Date.now();
    const HARD_MS = 300000;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      try { ws.close(); } catch { /* 忽略 */ }
      fn(arg);
    };
    // 长时间没数据就收尾：已经收到的帧照样返回（incomplete），别把整段导出拖死
    const watchdog = setInterval(() => {
      const now = Date.now();
      const idleLimit = frames.size ? 30000 : 90000;
      if (now - startedAt > HARD_MS || now - lastActivity > idleLimit) {
        finish(resolve, { frames, realFormat, incomplete: true });
      }
    }, 1000);

    ws.onmessage = (ev) => {
      lastActivity = Date.now();
      if (typeof ev.data === 'string') {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.event === 'ready') {
          realFormat = m.format || realFormat;
          ack(ws, 0);
        } else if (m.event === 'finish') {
          sawFinish = true;
          if (typeof m.code === 'number' && m.code !== 0) finish(reject, new TtsError(m.code, m.msg));
          else finish(resolve, { frames, realFormat });
        } else if (m.event === 'error') {
          finish(reject, new TtsError(m.code, m.msg || m.message));
        }
        return;
      }
      const view = new DataView(ev.data);
      const seq = view.getUint32(0, false);
      frames.set(seq, new Uint8Array(ev.data, 4));
      ack(ws, seq);
    };
    ws.onerror = () => finish(reject, new Error('websocket error'));
    ws.onclose = () => finish(resolve, { frames, realFormat, incomplete: !sawFinish && frames.size > 0 });
  });
}

function wavHeader(dataSize) {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const out = new Uint8Array(44);
  const view = new DataView(out.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);
  return out;
}

// 逐条编码：每段 MP3 帧都可以直接拼在一起播放，不必把整段 PCM 攒在内存里
function encodeMp3Parts(pcm) {
  if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) throw new Error('mp3-encoder-missing');
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const encoder = new lamejs.Mp3Encoder(1, SAMPLE_RATE, 128);
  const parts = [];
  const blockSize = 1152;
  for (let i = 0; i < samples.length; i += blockSize) {
    const buf = encoder.encodeBuffer(samples.subarray(i, i + blockSize));
    if (buf.length) parts.push(new Uint8Array(buf));
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  return parts;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* 忽略 */ } }, 120000);
}

function stampName() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/* ---------- SRT 字幕（配合导出的音频做视频） ---------- */
function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`;
}

// 按句末标点断句，长句再按长度硬切，便于一屏读一行
function splitCues(text, maxLen = 90) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…。！？]+[.!?…。！？]*/g) || [clean];
  const cues = [];
  let buf = '';
  const push = (value) => {
    let rest = value;
    while (rest.length > maxLen) {
      let cut = rest.lastIndexOf(' ', maxLen);
      if (cut < maxLen / 2) cut = maxLen;
      cues.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) cues.push(rest);
  };
  for (const raw of sentences) {
    const piece = raw.trim();
    if (!piece) continue;
    if (buf && buf.length + 1 + piece.length > maxLen) { push(buf); buf = piece; }
    else buf = buf ? buf + ' ' + piece : piece;
  }
  if (buf) push(buf);
  return cues.filter(Boolean);
}

function buildSrt(segments) {
  let index = 1;
  const blocks = [];
  for (const seg of segments) {
    const cues = splitCues(seg.text);
    if (!cues.length) continue;
    const totalChars = cues.reduce((n, c) => n + c.length, 0) || 1;
    let t = seg.start;
    for (const cue of cues) {
      const dur = Math.max(0.4, seg.duration * (cue.length / totalChars));
      blocks.push(`${index++}\n${srtTime(t)} --> ${srtTime(t + dur)}\n${cue}\n`);
      t += dur;
    }
  }
  return blocks.join('\n');
}

async function fetchTextMap(sessionId, tk) {
  const map = new Map();
  const add = (list) => {
    for (const m of Array.isArray(list) ? list : []) {
      const id = m && (m.message_id != null ? m.message_id : m.id);
      if (id == null) continue;
      const text = messageText(m).trim();
      if (text) map.set(String(id), text);
    }
  };

  try {
    const res = await api('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId) + '&cache_version=0', {}, tk);
    const biz = res && res.data && res.data.biz_data;
    if (biz) add(biz.chat_messages || biz.messages);
  } catch { /* 字幕是附加功能，失败就跳过 */ }

  if (!map.size) {
    try {
      const recorded = await requestPageMessages();
      if (recorded) add(recorded.messages);
    } catch { /* 忽略 */ }
  }
  return map;
}

/* ---------- 导出任务：在页面里跑，弹窗关掉也不会中断 ---------- */
const EXPORT_MAX_MESSAGES = 400;
let currentJob = null;

function jobSnapshot(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.items.length,
    done: job.done,
    skipped: job.skipped.length,
    seconds: Number(job.seconds.toFixed(1)),
    bytes: job.bytes,
    truncated: job.truncated,
    filename: job.filename,
    srtName: job.srtName,
    files: job.files,
    srtCount: job.srtNames ? job.srtNames.length : 0,
    error: job.error,
    code: job.code,
    cancelled: job.cancelled,
  };
}

async function runExport(job) {
  const tk = token();
  if (!tk) throw new Error('no-token');

  let baseVoice = null;
  let changed = false;
  const encoded = [];

  try {
    try { baseVoice = await readCurrentVoice(tk); } catch { baseVoice = null; }
    const textMap = job.srt ? await fetchTextMap(job.sessionId, tk) : null;

    for (const item of job.items) {
      if (job.cancel) { job.cancelled = true; break; }

      let result = null;
      let failure = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        try {
          const want = item.voiceId || baseVoice;
          if (want && want !== knownVoice) {
            if (!changed && baseVoice && !savedVoice()) savePendingVoice(baseVoice);
            await applyVoice(tk, want);
            changed = true;
          }
          result = await downloadPcm(job.sessionId, item.id, tk);
        } catch (e) {
          const code = e && typeof e.code === 'number' ? e.code : null;
          const message = String((e && e.message) || e);
          failure = { code, error: message };
          // 网络抖动 / 服务端没给音频：重试一次；额度类错误不重试
          const transient = !code && /no audio|websocket error|timeout/i.test(message);
          if (!transient) break;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
        }
      }

      if (result) {
        job.seconds += result.seconds;
        if (result.incomplete) job.truncated += 1;
        try {
          const piece = { seconds: result.seconds, text: textMap ? (textMap.get(item.id) || '') : '' };
          if (job.format === 'mp3') piece.mp3 = encodeMp3Parts(result.pcm);
          else piece.pcm = result.pcm;
          encoded.push(piece);
        } catch (e) {
          failure = { code: null, error: String((e && e.message) || e) };
          result = null;
        }
      }

      if (!result) {
        const code = failure ? failure.code : null;
        job.skipped.push({ id: item.id, code, error: failure ? failure.error : 'unknown' });
        // 额度用尽 / 无权限 / 服务不可用：后面的消息也不会成功，提前收尾
        if (code === 4 || code === 9 || code === 11) { job.code = code; break; }
      }
      job.done += 1;
    }

    if (!encoded.length) {
      const first = job.skipped[0];
      job.status = 'error';
      job.code = first ? first.code : null;
      job.error = job.cancelled ? 'cancelled' : (first ? first.error : 'no audio');
      return;
    }

    // 按目标时长切块：每块的音频与字幕各自独立，文件名带 -partNN
    const limit = job.split > 0 ? job.split * 60 : 0;
    const groups = [];
    if (!limit) {
      groups.push(encoded);
    } else {
      let cur = [];
      let curSeconds = 0;
      for (const piece of encoded) {
        if (cur.length && curSeconds + piece.seconds > limit) { groups.push(cur); cur = []; curSeconds = 0; }
        cur.push(piece);
        curSeconds += piece.seconds;
      }
      if (cur.length) groups.push(cur);
    }

    const base = `${job.prefix}-${stampName()}`;
    const ext = job.format === 'mp3' ? 'mp3' : 'wav';
    job.files = groups.length;
    job.filenames = [];

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const suffix = groups.length > 1 ? `-part${String(g + 1).padStart(2, '0')}` : '';
      const name = `${base}${suffix}.${ext}`;

      let blob;
      if (job.format === 'mp3') {
        blob = new Blob(group.flatMap((p) => p.mp3), { type: 'audio/mpeg' });
      } else {
        let size = 0;
        for (const p of group) size += p.pcm.length;
        blob = new Blob([wavHeader(size), ...group.map((p) => p.pcm)], { type: 'audio/wav' });
      }

      job.bytes += blob.size;
      job.filenames.push(name);
      if (!job.filename) job.filename = name;
      triggerDownload(blob, name);

      if (job.srt) {
        const segments = [];
        let offset = 0;
        for (const p of group) {
          if (p.text) segments.push({ text: p.text, start: offset, duration: p.seconds });
          offset += p.seconds;
        }
        const srt = buildSrt(segments);
        if (srt) {
          const srtName = `${base}${suffix}.srt`;
          job.srtNames.push(srtName);
          if (!job.srtName) job.srtName = srtName;
          triggerDownload(new Blob([srt], { type: 'application/x-subrip' }), srtName);
        }
      }
    }

    job.status = 'done';
  } finally {
    if (changed && baseVoice) {
      try {
        await applyVoice(tk, baseVoice);
        savePendingVoice(null);
      } catch { knownVoice = null; }
    }
  }
}

/* ---------- 按角色切换音色（下载对话时用） ---------- */
const VOICE_STORE = '__dsTtsPendingVoice';
let knownVoice = null;
let restoring = null;

async function readCurrentVoice(tk) {
  if (knownVoice) return knownVoice;
  const res = await api('/api/v0/chat/tts/voices', {}, tk);
  const id = res && res.code === 0 && res.data && res.data.biz_code === 0 && res.data.biz_data
    ? res.data.biz_data.current_voice_id
    : null;
  if (id) knownVoice = id;
  return id;
}

async function applyVoice(tk, voiceId) {
  const res = await api('/api/v0/chat/tts/voice', { method: 'POST', body: JSON.stringify({ voice_id: voiceId }) }, tk);
  if (!res || res.code !== 0 || !res.data || res.data.biz_code !== 0) {
    throw new Error('setVoice: ' + JSON.stringify(res).slice(0, 200));
  }
  knownVoice = voiceId;
}

function savedVoice() {
  try { return sessionStorage.getItem(VOICE_STORE); } catch { return null; }
}

function savePendingVoice(value) {
  try {
    if (value) sessionStorage.setItem(VOICE_STORE, value);
    else sessionStorage.removeItem(VOICE_STORE);
  } catch { /* 忽略 */ }
}

async function restoreSavedVoice(tk) {
  const saved = savedVoice();
  if (!saved) return null;
  if (knownVoice === saved) {
    savePendingVoice(null);
    return saved;
  }
  if (restoring) return restoring;
  restoring = (async () => {
    try {
      await applyVoice(tk, saved);
      savePendingVoice(null);
      return saved;
    } catch (e) {
      knownVoice = null;
      throw e;
    } finally {
      restoring = null;
    }
  })();
  return restoring;
}

// 弹窗中途被关掉时，页面下次加载把临时切换的音色恢复回去
setTimeout(() => {
  try {
    const tk = token();
    if (tk) restoreSavedVoice(tk).catch(() => {});
  } catch { /* 忽略 */ }
}, 1500);

async function downloadPcm(sessionId, messageId, tk) {
  const ticketRes = await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) }, tk);
  if (!ticketRes || ticketRes.code !== 0 || !ticketRes.data || ticketRes.data.biz_code !== 0) {
    throw new Error('ticket: ' + JSON.stringify(ticketRes).slice(0, 200));
  }

  const { frames, realFormat, incomplete } = await synthesizePcm(sessionId, messageId, ticketRes.data.biz_data.ticket);
  if (realFormat !== 'pcm') throw new Error('unsupported format: ' + realFormat);

  const seqs = [...frames.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const seq of seqs) total += frames.get(seq).length;
  if (!total) throw new Error('no audio');

  const pcm = new Uint8Array(total);
  let offset = 0;
  for (const seq of seqs) {
    const chunk = frames.get(seq);
    pcm.set(chunk, offset);
    offset += chunk.length;
  }
  return { pcm, seconds: total / 2 / SAMPLE_RATE, incomplete: !!incomplete };
}

// 跨浏览器：Firefox 用 browser.*（Promise），Chrome/Edge 用 chrome.*
// 注意：下面已有一个叫 api() 的取接口函数，所以这里叫 ext
const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

ext.runtime.onMessage.addListener((msg, _sender, reply) => {
  let replied = false;
  const done = (payload) => {
    if (replied) return;
    replied = true;
    try { reply(payload); } catch { /* 弹窗已关 */ }
  };

  (async () => {
    try {
      const tk = token();
      if (msg.type === 'status') {
        done({
          ok: true,
          bridgeVersion: BRIDGE_VERSION,
          installed: document.documentElement.getAttribute('data-ds-tts-unlock') === '1',
          hasToken: !!tk,
          gray: grayInfo(),
          href: location.href,
        });
      } else if (msg.type === 'voices') {
        done({ ok: true, data: await api('/api/v0/chat/tts/voices', {}, tk) });
      } else if (msg.type === 'setVoice') {
        const res = await api('/api/v0/chat/tts/voice', { method: 'POST', body: JSON.stringify({ voice_id: msg.voiceId }) }, tk);
        if (res && res.code === 0 && res.data && res.data.biz_code === 0) {
          knownVoice = msg.voiceId;
          savePendingVoice(null);
        }
        done({ ok: true, data: res });
      } else if (msg.type === 'ticket') {
        done({ ok: true, data: await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) }, tk) });
      } else if (msg.type === 'messages') {
        const sessionId = sessionIdFromUrl();
        if (!sessionId) { done({ ok: false, error: 'no-session' }); return; }

        let messages = [];
        let total = 0;
        let keys = [];
        let apiError = null;

        // 1) 正常路径：插件自己调官方历史接口
        // cache_version=0 强制服务端返回全量快照（否则可能拿到 MERGE / 0 条增量）
        const res = await api('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sessionId) + '&cache_version=0', {}, tk);
        if (res && res.code === 0 && res.data && res.data.biz_code === 0) {
          const biz = (res.data && res.data.biz_data) || {};
          const list = biz.chat_messages || biz.messages || [];
          keys = Object.keys(biz).slice(0, 12);
          total = Array.isArray(list) ? list.length : 0;
          messages = mapMessageList(list);
        } else {
          apiError = 'messages api: ' + JSON.stringify(res).slice(0, 200);
        }

        // 2) 兜底：用官方前端自己拉到的同一份历史（inject.js 捕获）
        if (!messages.length) {
          const recorded = await requestPageMessages();
          const fromPage = recorded && (!recorded.sessionId || recorded.sessionId === sessionId)
            ? recorded.messages
            : null;
          const pageList = mapMessageList(fromPage);
          if (pageList.length) {
            messages = pageList;
            total = fromPage.length;
            keys = [];
            console.info('[ds-tts] 使用页面缓存的历史消息兜底');
          }
        }

        if (!messages.length && apiError) {
          done({ ok: false, error: apiError });
          return;
        }
        if (!messages.length) {
          console.warn('[ds-tts] history_messages 没有可用消息；keys =', keys, '；消息条数 =', total);
        } else {
          console.debug('[ds-tts] history_messages：', messages.length, '条');
        }
        done({ ok: true, data: { sessionId, messages, total, keys } });
      } else if (msg.type === 'exportStart') {
        const sessionId = sessionIdFromUrl();
        if (!sessionId) { done({ ok: false, error: 'no-session' }); return; }
        if (!tk) { done({ ok: false, error: 'no-token' }); return; }
        if (currentJob && currentJob.status === 'running') {
          done({ ok: false, error: 'busy' });
          return;
        }
        const items = (Array.isArray(msg.items) ? msg.items : [])
          .filter((x) => x && x.id != null)
          .slice(0, EXPORT_MAX_MESSAGES)
          .map((x) => ({ id: String(x.id), voiceId: x.voiceId || null }));
        if (!items.length) { done({ ok: false, error: 'no-message' }); return; }

        currentJob = {
          id: 'job' + Date.now().toString(36),
          sessionId,
          items,
          format: msg.format === 'wav' ? 'wav' : 'mp3',
          prefix: msg.prefix === 'dialog' ? 'deepseek-dialog' : 'deepseek-tts',
          split: Number(msg.split) > 0 ? Number(msg.split) : 0,
          srt: !!msg.srt,
          srtName: null,
          srtNames: [],
          files: 0,
          filenames: [],
          status: 'running',
          done: 0,
          seconds: 0,
          truncated: 0,
          skipped: [],
          bytes: 0,
          filename: null,
          error: null,
          code: null,
          cancel: false,
          cancelled: false,
        };
        done({ ok: true, data: jobSnapshot(currentJob) });
        runExport(currentJob).catch((e) => {
          currentJob.status = 'error';
          currentJob.error = String((e && e.message) || e);
          currentJob.code = e && typeof e.code === 'number' ? e.code : null;
        });
      } else if (msg.type === 'exportStatus') {
        if (currentJob && (!msg.jobId || msg.jobId === currentJob.id)) {
          done({ ok: true, data: jobSnapshot(currentJob) });
        } else {
          done({ ok: true, data: null });
        }
      } else if (msg.type === 'exportCancel') {
        if (currentJob && currentJob.status === 'running') currentJob.cancel = true;
        done({ ok: true, data: currentJob ? jobSnapshot(currentJob) : null });
      } else if (msg.type === 'restoreVoice') {
        if (!tk) { done({ ok: true, data: { voice: null } }); return; }
        done({ ok: true, data: { voice: await restoreSavedVoice(tk) } });
      } else if (msg.type === 'reset') {
        // 清掉本地配置缓存：下次加载会从服务端重新拉真值，缓存里的补丁一起消失
        localStorage.removeItem(KEY);
        done({ ok: true });
        setTimeout(() => location.reload(), 120);
      } else {
        done({ ok: false, error: 'unknown message: ' + msg.type });
      }
    } catch (e) {
      done({ ok: false, error: String(e), code: (e && typeof e.code === 'number') ? e.code : null });
    }
  })();

  return true; // 异步回复
});
