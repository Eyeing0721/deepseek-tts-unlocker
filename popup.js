/* 弹窗：注入状态 / 真实灰度状态 / 界面语言 / 朗读语言与音色
 *
 * 跨浏览器：Firefox 用 browser.*（Promise 风格），Chrome / Edge 用 chrome.*
 * （Chrome MV3 的 tabs / permissions 同样支持 Promise，所以一套代码两边都能跑）
 *
 * 界面语言与朗读语言存在扩展页的 localStorage 里（同源，无需额外权限）。
 */

const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
const ORIGINS = ['https://chat.deepseek.com/*'];
const SETTINGS_KEY = 'ds-tts-popup-settings';
const LANGS = UI_LANGS.map((l) => l.code);

const $ = (id) => document.getElementById(id);

// 拼 HTML 前把服务端来的字符串转义掉
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  uiLang: 'en',
  voiceLang: 'zh',
  mode: 'checking',
  tab: null,
  st: null,
  voices: null,
  voicesTried: false,
  voiceLangs: [],
  messages: null,
  messagesTried: false,
  sessionMissing: false,
  bridgeOutdated: false,
  messagesEmpty: false,
  selectedMessage: null,
  downloading: false,
  exportJob: null,
  audioMsg: null,
  selectedVoice: null,
  assistantVoice: null,
  userVoice: null,
  audioFormat: 'mp3',
  wholeDialog: false,
  subs: false,
  split: 0,
  saving: false,
  granting: false,
  audio: null,
  msg: null,
};

/* ---------- 文案 ---------- */

function t(key, vars) {
  const dict = I18N[state.uiLang] || I18N.en;
  const raw = dict[key] != null ? dict[key] : (I18N.en[key] != null ? I18N.en[key] : key);
  return String(raw).replace(/\{(\w+)\}/g, (m, k) => (
    vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  ));
}

function langName(code) {
  try {
    const dn = new Intl.DisplayNames([state.uiLang], { type: 'language' });
    return dn.of(String(code).replace(/_/g, '-')) || String(code);
  } catch {
    return String(code);
  }
}

// 俄语等语言的 Intl 名称是小写，下拉框里首字母大写更自然
function langOptionName(code) {
  const name = langName(code);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : name;
}

function setMsg(key, vars, cls) {
  state.msg = { key, vars, cls: cls || 'muted' };
}

function setRawMsg(text, cls) {
  state.msg = { raw: String(text || ''), cls: cls || 'muted' };
}

function shortJson(value) {
  let out;
  try { out = typeof value === 'string' ? value : JSON.stringify(value); } catch { out = String(value); }
  return String(out ?? '').slice(0, 160);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

/* ---------- 语音元数据 ---------- */

function voiceLanguages(voice) {
  const set = new Set();
  const add = (code) => {
    if (!code) return;
    const base = String(code).toLowerCase().split(/[-_]/)[0];
    if (/^[a-z]{2,3}$/.test(base)) set.add(base);
  };
  const langs = voice && voice.languages;
  if (Array.isArray(langs)) {
    for (const item of langs) {
      if (typeof item === 'string') add(item);
      else if (item && typeof item === 'object') add(item.code || item.lang || item.language || item.locale || item.id || item.value);
    }
  } else if (langs && typeof langs === 'object') {
    Object.keys(langs).forEach(add);
  }
  const demos = voice && voice.demo_urls;
  if (Array.isArray(demos)) {
    for (const item of demos) {
      if (item && typeof item === 'object') add(item.lang || item.language || item.code || item.locale);
    }
  } else if (demos && typeof demos === 'object') {
    Object.keys(demos).forEach(add);
  }
  return set;
}

function asDemoUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return value.url || value.src || value.href || null;
  return null;
}

function demoUrl(voice, lang) {
  const demos = voice && voice.demo_urls;
  if (!demos) return null;
  const base = String(lang).toLowerCase().split(/[-_]/)[0];
  if (Array.isArray(demos)) {
    const hit = demos.find((item) => item && typeof item === 'object'
      && [item.lang, item.language, item.code, item.locale].some((c) => String(c || '').toLowerCase().split(/[-_]/)[0] === base));
    return asDemoUrl(hit);
  }
  if (typeof demos === 'object') {
    if (demos[lang] !== undefined) return asDemoUrl(demos[lang]);
    if (demos[base] !== undefined) return asDemoUrl(demos[base]);
    const key = Object.keys(demos).find((k) => k.toLowerCase().split(/[-_]/)[0] === base);
    return key ? asDemoUrl(demos[key]) : null;
  }
  return asDemoUrl(demos);
}

function voiceText(voice, lang) {
  const id = (voice && voice.voice_id) || '';
  const fb = VOICE_FALLBACK[id] || {};
  const fallbackKey = (field) => (field === 'name_i18n' ? 'name' : 'desc');
  const pick = (field) => pickI18n(voice && voice[field], lang)
    || (fb[lang] && fb[lang][fallbackKey(field)])
    || pickI18n(voice && voice[field], 'en')
    || (fb.en && fb.en[fallbackKey(field)])
    || pickI18n(voice && voice[field], 'zh')
    || (fb.zh && fb.zh[fallbackKey(field)]);
  return { name: pick('name_i18n') || id, desc: pick('description_i18n') || '' };
}

function selectedVoice() {
  const list = state.voices && Array.isArray(state.voices.voices) ? state.voices.voices : [];
  return list.find((v) => v.voice_id === state.selectedVoice) || null;
}

function availableVoiceLangs() {
  const set = new Set(state.voiceLangs);
  if (!set.size) ['zh', 'en', 'ru'].forEach((c) => set.add(c));
  if (state.voiceLang) set.add(state.voiceLang);
  return [...set];
}

/* ---------- 设置 ---------- */

function loadSettings() {
  state.uiLang = detectUiLang();
  state.voiceLang = state.uiLang;
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || {};
    if (LANGS.includes(saved.uiLang)) state.uiLang = saved.uiLang;
    const voiceLang = String(saved.voiceLang || '').toLowerCase();
    if (/^[a-z]{2,3}$/.test(voiceLang)) state.voiceLang = voiceLang;
    if (typeof saved.assistantVoice === 'string') state.assistantVoice = saved.assistantVoice;
    if (typeof saved.userVoice === 'string') state.userVoice = saved.userVoice;
    if (saved.audioFormat === 'wav' || saved.audioFormat === 'mp3') state.audioFormat = saved.audioFormat;
    state.wholeDialog = !!saved.wholeDialog;
    state.subs = !!saved.subs;
    const split = Number(saved.split);
    if ([0, 5, 10, 20].includes(split)) state.split = split;
  } catch { /* 设置损坏就回到默认 */ }
}

function persistSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      uiLang: state.uiLang,
      voiceLang: state.voiceLang,
      assistantVoice: state.assistantVoice,
      userVoice: state.userVoice,
      audioFormat: state.audioFormat,
      wholeDialog: state.wholeDialog,
      subs: state.subs,
      split: state.split,
    }));
  } catch { /* 存不了就只在本窗口生效 */ }
}

function reconcileVoiceLang() {
  if (!state.voiceLangs.length || state.voiceLangs.includes(state.voiceLang)) return;
  state.voiceLang = state.voiceLangs.includes(state.uiLang)
    ? state.uiLang
    : (state.voiceLangs.includes('zh') ? 'zh' : state.voiceLangs[0]);
  persistSettings();
}

/* ---------- 渲染 ---------- */

function applyStatic() {
  document.documentElement.lang = state.uiLang;
  document.title = t('appName');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
}

function renderLangSelects() {
  const ui = $('uiLang');
  if (ui.options.length !== UI_LANGS.length) {
    ui.innerHTML = UI_LANGS.map((l) => `<option value="${esc(l.code)}">${esc(l.label)}</option>`).join('');
  }
  ui.value = state.uiLang;

  const langs = availableVoiceLangs();
  const names = new Map(langs.map((code) => [code, langOptionName(code)]));
  let collator = null;
  try { collator = new Intl.Collator(state.uiLang); } catch { /* 按语言码排 */ }
  langs.sort((a, b) => (collator ? collator.compare(names.get(a), names.get(b)) : a.localeCompare(b)));

  const voiceLang = $('voiceLang');
  voiceLang.innerHTML = langs.map((code) => `<option value="${esc(code)}">${esc(names.get(code))}</option>`).join('');
  voiceLang.value = state.voiceLang;
}

function renderStatus() {
  const dot = $('dot');
  const page = $('page');
  const gray = $('gray');
  const grant = $('grant');
  const build = $('build');
  grant.hidden = true;
  gray.textContent = '';

  const extVersion = (() => {
    try { return api.runtime.getManifest().version; } catch { return '?'; }
  })();
  const bridgeVersion = state.st && typeof state.st.bridgeVersion === 'number' ? state.st.bridgeVersion : null;
  build.textContent = bridgeVersion != null
    ? `v${extVersion} · bridge v${bridgeVersion}`
    : `v${extVersion}`;

  if (state.mode === 'checking') {
    dot.className = 'dot';
    page.textContent = t('checking');
    return;
  }
  if (state.mode === 'wrongTab') {
    dot.className = 'dot off';
    page.innerHTML = t('wrongTab');
    return;
  }
  if (state.mode === 'noPermission') {
    dot.className = 'dot off';
    page.innerHTML = t('needPerm');
    grant.hidden = false;
    grant.disabled = state.granting;
    return;
  }
  if (state.mode === 'notInjected') {
    dot.className = 'dot off';
    page.innerHTML = t('notInjected');
    return;
  }

  const st = state.st || {};
  dot.className = 'dot ' + (st.installed ? 'on' : 'off');
  page.innerHTML = st.installed
    ? t('pageUnlocked') + ' · ' + (st.hasToken ? t('loginYes') : t('loginNo'))
    : t('pageLocked');

  const info = st.gray;
  if (!info || !info.models) {
    gray.textContent = t('grayNoCache');
    return;
  }
  const grayed = info.models.some((m) => m.gray);
  gray.innerHTML = (grayed ? t('grayHas') : t('grayNot')) + `<ul id="models">${info.models
    .map((m) => `<li>${esc(m.model)}${m.enabled ? '' : esc(t('modelOff'))} · tts_feature = ${esc(String(m.gray))}</li>`)
    .join('')}</ul>`;
}

function renderVoiceSection() {
  const sel = $('voice');
  const save = $('save');
  const preview = $('preview');
  const info = $('voiceInfo');
  const data = state.voices;
  const list = data && Array.isArray(data.voices) ? data.voices : [];

  if (!list.length) {
    sel.innerHTML = `<option>${esc((state.voices || state.voicesTried) ? t('voicesError') : t('loading'))}</option>`;
    sel.disabled = true;
    save.disabled = true;
    preview.disabled = true;
    preview.title = '';
    info.textContent = '';
    return;
  }

  if (!list.some((v) => v.voice_id === state.selectedVoice)) {
    const current = list.find((v) => v.voice_id === data.current_voice_id) || list[0];
    state.selectedVoice = current.voice_id;
  }

  sel.innerHTML = list.map((voice) => {
    const text = voiceText(voice, state.voiceLang);
    const langs = voiceLanguages(voice);
    const unsupported = langs.size > 0 && !langs.has(state.voiceLang);
    const label = text.desc ? `${text.name} — ${text.desc}` : text.name;
    const suffix = unsupported ? '  ' + t('unsupportedVoice', { lang: langName(state.voiceLang) }) : '';
    return `<option value="${esc(voice.voice_id)}">${esc(label + suffix)}</option>`;
  }).join('');
  sel.value = state.selectedVoice;
  sel.disabled = false;
  save.disabled = state.saving;

  const voice = selectedVoice();
  const langs = voice ? voiceLanguages(voice) : new Set();
  const parts = [];
  if (langs.size) parts.push(t('supportsCount', { n: langs.size }));
  if (voice && langs.size && !langs.has(state.voiceLang)) {
    parts.push(t('unsupportedVoice', { lang: langName(state.voiceLang) }));
  }
  info.textContent = parts.join(' · ');

  const url = voice ? demoUrl(voice, state.voiceLang) : null;
  preview.disabled = state.saving || !url;
  preview.title = url ? '' : t('previewMissing');
}

function renderMsg() {
  const el = $('msg');
  if (!state.msg) {
    el.innerHTML = '';
    return;
  }
  let body;
  if (state.msg.raw != null) {
    body = esc(state.msg.raw);
  } else {
    const vars = {};
    for (const [key, value] of Object.entries(state.msg.vars || {})) vars[key] = esc(value);
    body = t(state.msg.key, vars);
  }
  el.innerHTML = body ? `<span class="${state.msg.cls}">${body}</span>` : '';
}

function setAudioMsg(key, vars, cls, suffix) {
  state.audioMsg = { key, vars, cls: cls || 'muted', suffix: suffix || '' };
}

function messageLabel(m) {
  const who = m.role === 'user' ? t('roleUser') : (m.role === 'assistant' ? t('roleAssistant') : '');
  const preview = String(m.preview || '').slice(0, 80);
  return (who ? who + ': ' : '') + preview;
}

function fillVoiceSelect(select, value, list) {
  if (!list.length) {
    select.innerHTML = '';
    select.disabled = true;
    return;
  }
  select.innerHTML = list.map((voice) => {
    const name = voiceText(voice, state.voiceLang).name;
    return `<option value="${esc(voice.voice_id)}">${esc(name)}</option>`;
  }).join('');
  if (list.some((v) => v.voice_id === value)) select.value = value;
  select.disabled = state.downloading;
}

function renderAudioSection() {
  const sel = $('message');
  const btn = $('download');
  const cancel = $('cancelExport');
  const reload = $('reloadPage');
  const info = $('audioInfo');
  const format = $('audioFormat');
  const whole = $('wholeDialog');
  const srt = $('srt');
  const split = $('split');
  const list = state.messages || [];
  const voices = state.voices && Array.isArray(state.voices.voices) ? state.voices.voices : [];

  if (state.bridgeOutdated || state.messagesEmpty) $('audioBox').open = true;

  format.value = state.audioFormat;
  format.disabled = state.downloading;
  whole.checked = state.wholeDialog;
  whole.disabled = state.downloading || !list.length;
  srt.checked = state.subs;
  srt.disabled = state.downloading;
  split.value = String(state.split);
  split.disabled = state.downloading;
  cancel.hidden = !state.downloading;
  fillVoiceSelect($('assistantVoice'), state.assistantVoice, voices);
  fillVoiceSelect($('userVoice'), state.userVoice, voices);

  if (!list.length) {
    let key = 'loading';
    if (state.messagesTried) {
      if (state.bridgeOutdated) key = 'audioReload';
      else if (state.sessionMissing) key = 'openConversation';
      else if (state.mode !== 'ready') key = 'audioUnavailable';
      else key = 'noMessages';
    }
    sel.innerHTML = `<option>${esc(t(key))}</option>`;
    sel.disabled = true;
    btn.disabled = true;
    btn.textContent = t(state.audioFormat === 'wav' ? 'downloadWav' : 'downloadMp3');
    reload.hidden = !(state.bridgeOutdated || state.messagesEmpty);
    reload.disabled = false;
    info.textContent = '';
    return;
  }

  const ordered = [...list].reverse();
  if (!ordered.some((m) => m.id === state.selectedMessage)) state.selectedMessage = ordered[0].id;
  sel.innerHTML = ordered.map((m) => `<option value="${esc(m.id)}">${esc(messageLabel(m))}</option>`).join('');
  sel.value = state.selectedMessage;
  sel.disabled = state.downloading || state.wholeDialog;
  btn.disabled = state.downloading;
  btn.textContent = state.downloading
    ? t('downloading')
    : t(state.audioFormat === 'wav' ? 'downloadWav' : 'downloadMp3');
  reload.hidden = true;
  info.textContent = state.wholeDialog ? t('dialogHint') : t('downloadHint');
}

function renderAudioMsg() {
  const el = $('audioMsg');
  if (!state.audioMsg) {
    el.innerHTML = '';
    return;
  }
  const vars = {};
  for (const [key, value] of Object.entries(state.audioMsg.vars || {})) vars[key] = esc(value);
  const suffix = state.audioMsg.suffix ? ' · ' + state.audioMsg.suffix : '';
  el.innerHTML = `<span class="${state.audioMsg.cls}">${t(state.audioMsg.key, vars)}${suffix}</span>`;
}

function render() {
  applyStatic();
  renderLangSelects();
  renderStatus();
  renderVoiceSection();
  renderMsg();
  renderAudioSection();
  renderAudioMsg();
}

/* ---------- 扩展 API ---------- */

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function send(tabId, payload) {
  try {
    const res = await api.tabs.sendMessage(tabId, payload);
    return res || { ok: false, error: 'empty response' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Firefox 把 host permission 当成「可选项」，装了不一定就给了；Chrome 装了就有
async function hasHostPermission() {
  if (!api.permissions || !api.permissions.contains) return true;
  try { return await api.permissions.contains({ origins: ORIGINS }); } catch { return true; }
}

/* ---------- 操作 ---------- */

async function grantAccess() {
  if (!state.tab) return;
  state.granting = true;
  render();
  try {
    await api.permissions.request({ origins: ORIGINS });
  } catch (e) {
    state.granting = false;
    setMsg('grantFailed', { err: shortJson((e && e.message) || e) }, 'bad');
    render();
    return;
  }
  if (await hasHostPermission()) {
    setMsg('grantedReloading', null, 'ok');
    render();
    try { await api.tabs.reload(state.tab.id); } catch { /* 忽略 */ }
    setTimeout(() => window.close(), 500);
  } else {
    state.granting = false;
    setMsg('notGranted', null, 'bad');
    render();
  }
}

async function saveVoice() {
  if (!state.tab || !state.selectedVoice) return;
  const voiceId = state.selectedVoice;
  const voice = selectedVoice();
  const name = voice ? voiceText(voice, state.voiceLang).name : voiceId;

  state.saving = true;
  stopAudio();
  setMsg('switching');
  render();
  const res = await send(state.tab.id, { type: 'setVoice', voiceId });
  const code = res.ok && res.data && res.data.code === 0 ? res.data.data.biz_code : null;
  if (code === 0) {
    if (state.voices) state.voices.current_voice_id = voiceId;
    setMsg('switched', { name }, 'ok');
  } else {
    const detail = (res.data && res.data.data) || res.data || res.error || 'unknown';
    setMsg('switchFailed', { err: shortJson(detail) }, 'bad');
  }
  state.saving = false;
  render();
}

function stopAudio() {
  if (!state.audio) return;
  try { state.audio.pause(); } catch { /* 忽略 */ }
  state.audio = null;
}

function previewVoice() {
  const voice = selectedVoice();
  const url = voice ? demoUrl(voice, state.voiceLang) : null;
  if (!url) {
    setMsg('previewMissing', null, 'bad');
    renderMsg();
    return;
  }
  stopAudio();
  try {
    const audio = new Audio(url);
    state.audio = audio;
    audio.addEventListener('ended', () => {
      if (state.audio === audio) state.audio = null;
    });
    audio.addEventListener('error', () => {
      if (state.audio === audio) state.audio = null;
      setMsg('previewFailed', { err: 'media error' }, 'bad');
      renderMsg();
    });
    setMsg('previewPlaying', { name: voiceText(voice, state.voiceLang).name, lang: langName(state.voiceLang) }, 'ok');
    renderMsg();
    audio.play().catch((e) => {
      if (state.audio === audio) state.audio = null;
      setMsg('previewFailed', { err: shortJson((e && e.message) || e) }, 'bad');
      renderMsg();
    });
  } catch (e) {
    setMsg('previewFailed', { err: shortJson((e && e.message) || e) }, 'bad');
    renderMsg();
  }
}

async function resetCache() {
  if (!state.tab) return;
  $('reset').disabled = true;
  stopAudio();
  setMsg('resetting');
  renderMsg();
  await send(state.tab.id, { type: 'reset' });
}

async function reloadPage() {
  if (!state.tab) return;
  try { await api.tabs.reload(state.tab.id); } catch { /* 忽略 */ }
  setTimeout(() => window.close(), 300);
}

async function loadMessages(tabId) {
  state.messagesTried = true;
  const res = await send(tabId, { type: 'messages' });
  if (res && res.ok && res.data && Array.isArray(res.data.messages)) {
    state.messages = res.data.messages;
    state.sessionMissing = false;
    state.messagesEmpty = state.messages.length === 0;
    if (state.messages.length) {
      state.selectedMessage = state.messages[state.messages.length - 1].id;
    } else {
      setAudioMsg('noMessagesHint');
    }
  } else if (res && res.error === 'no-session') {
    state.sessionMissing = true;
  } else if (res && /unknown message/i.test(res.error || '')) {
    // 老版 content script 不认识 messages：刷新页面即可
    state.bridgeOutdated = true;
    setAudioMsg('bridgeOutdated', null, 'bad');
  } else {
    setAudioMsg('messagesFailed', { err: shortJson((res && res.error) || res) }, 'bad');
  }
  renderAudioSection();
  renderAudioMsg();
}

function roleVoiceFor(role) {
  if (state.voices && Array.isArray(state.voices.voices)) {
    const ids = new Set(state.voices.voices.map((v) => v.voice_id));
    const want = role === 'user' ? state.userVoice : state.assistantVoice;
    if (want && ids.has(want)) return want;
  }
  return null;
}

function ttsErrorKey(code) {
  if (typeof code !== 'number') return null;
  const key = 'ttsError' + code;
  const dict = I18N[state.uiLang] || I18N.en;
  return dict[key] != null ? key : null;
}

let exportTimer = null;

function stopExportPolling() {
  if (exportTimer) clearTimeout(exportTimer);
  exportTimer = null;
}

async function pollExport(jobId) {
  if (!state.tab) return;
  const res = await send(state.tab.id, { type: 'exportStatus', jobId });
  if (!res || !res.ok) {
    state.downloading = false;
    stopExportPolling();
    setAudioMsg('downloadFailed', { err: shortJson((res && res.error) || res) }, 'bad');
    renderAudioSection();
    renderAudioMsg();
    return;
  }

  const job = res.data;
  if (!job) {
    state.downloading = false;
    stopExportPolling();
    renderAudioSection();
    return;
  }

  state.exportJob = job;
  if (job.status === 'running') {
    setAudioMsg('downloadProgress', { done: job.done, total: job.total }, 'muted');
    renderAudioSection();
    renderAudioMsg();
    exportTimer = setTimeout(() => pollExport(jobId), 800);
    return;
  }

  state.downloading = false;
  stopExportPolling();

  if (job.status === 'done') {
    const sec = Number(job.seconds).toFixed(1);
    const size = formatSize(job.bytes);
    const extras = [];
    if (job.files > 1) extras.push(esc(t('partsSaved', { n: job.files })));
    if (job.srtCount > 1) extras.push(esc(t('srtCountSaved', { n: job.srtCount })));
    else if (job.srtName) extras.push(esc(t('srtSaved', { name: job.srtName })));
    if (job.truncated) extras.push(esc(t('truncated', { n: job.truncated })));
    const extra = extras.join(' · ');
    if (job.cancelled) setAudioMsg('exportCancelled', { sec, size, done: job.done, total: job.total }, 'muted', extra);
    else if (job.skipped) setAudioMsg('dialogDoneSkipped', { sec, size, n: job.skipped }, 'ok', extra);
    else setAudioMsg('downloadDone', { sec, size }, 'ok', extra);
  } else {
    const key = ttsErrorKey(job.code);
    if (key) setAudioMsg(key, null, 'bad');
    else if (job.error === 'mp3-encoder-missing') setAudioMsg('bridgeOutdated', null, 'bad');
    else if (job.error === 'cancelled') setAudioMsg('exportCancelled', { sec: '0', size: formatSize(0), done: job.done, total: job.total }, 'muted');
    else if (/timeout/i.test(job.error || '')) setAudioMsg('ttsTimeout', null, 'bad');
    else if (/no audio/i.test(job.error || '')) setAudioMsg('ttsNoAudio', null, 'bad');
    else setAudioMsg('downloadFailed', { err: shortJson(job.error || 'unknown') }, 'bad');
  }

  renderAudioSection();
  renderAudioMsg();
}

async function cancelExport() {
  if (!state.tab || !state.exportJob) return;
  setAudioMsg('cancelling');
  renderAudioMsg();
  await send(state.tab.id, { type: 'exportCancel', jobId: state.exportJob.id });
}

async function downloadAudio() {
  if (!state.tab || state.downloading) return;
  const all = Array.isArray(state.messages) ? state.messages : [];
  const single = all.find((m) => m.id === state.selectedMessage) || null;
  const list = state.wholeDialog ? all : (single ? [single] : []);
  if (!list.length) return;

  const items = list.map((m) => ({ id: m.id, voiceId: roleVoiceFor(m.role) || null }));

  state.downloading = true;
  state.exportJob = null;
  stopAudio();
  stopExportPolling();
  setAudioMsg('downloadProgress', { done: 0, total: items.length }, 'muted');
  renderAudioSection();
  renderAudioMsg();

  const res = await send(state.tab.id, {
    type: 'exportStart',
    items,
    format: state.audioFormat,
    prefix: state.wholeDialog ? 'dialog' : 'single',
    split: state.split,
    srt: state.subs,
  });

  if (!res || !res.ok) {
    state.downloading = false;
    const key = ttsErrorKey(res && res.code);
    if (key) setAudioMsg(key, null, 'bad');
    else if (res && res.error === 'no-token') setAudioMsg('needLogin', null, 'bad');
    else if (res && res.error === 'busy') setAudioMsg('exportBusy', null, 'bad');
    else setAudioMsg('downloadFailed', { err: shortJson((res && res.error) || res) }, 'bad');
    renderAudioSection();
    renderAudioMsg();
    return;
  }

  state.exportJob = res.data;
  pollExport(res.data && res.data.id);
}

/* ---------- 事件 ---------- */

function bind() {
  $('uiLang').addEventListener('change', () => {
    const previous = state.uiLang;
    state.uiLang = $('uiLang').value;
    if (state.voiceLang === previous && availableVoiceLangs().includes(state.uiLang)) {
      state.voiceLang = state.uiLang;
    }
    stopAudio();
    persistSettings();
    render();
  });

  $('voiceLang').addEventListener('change', () => {
    state.voiceLang = $('voiceLang').value;
    stopAudio();
    persistSettings();
    render();
  });

  $('voice').addEventListener('change', () => {
    state.selectedVoice = $('voice').value;
    stopAudio();
    renderVoiceSection();
  });

  $('message').addEventListener('change', () => {
    state.selectedMessage = $('message').value;
    state.audioMsg = null;
    renderAudioMsg();
  });

  $('assistantVoice').addEventListener('change', () => {
    state.assistantVoice = $('assistantVoice').value;
    persistSettings();
  });

  $('userVoice').addEventListener('change', () => {
    state.userVoice = $('userVoice').value;
    persistSettings();
  });

  $('audioFormat').addEventListener('change', () => {
    state.audioFormat = $('audioFormat').value === 'wav' ? 'wav' : 'mp3';
    persistSettings();
    renderAudioSection();
  });

  $('wholeDialog').addEventListener('change', () => {
    state.wholeDialog = $('wholeDialog').checked;
    persistSettings();
    renderAudioSection();
  });

  $('srt').addEventListener('change', () => {
    state.subs = $('srt').checked;
    persistSettings();
    renderAudioSection();
  });

  $('split').addEventListener('change', () => {
    const value = Number($('split').value);
    state.split = [0, 5, 10, 20].includes(value) ? value : 0;
    persistSettings();
    renderAudioSection();
  });

  $('save').onclick = saveVoice;
  $('preview').onclick = previewVoice;
  $('download').onclick = downloadAudio;
  $('cancelExport').onclick = cancelExport;
  $('reloadPage').onclick = reloadPage;
  $('reset').onclick = resetCache;
  $('grant').onclick = grantAccess;
}

/* ---------- 启动 ---------- */

(async () => {
  loadSettings();
  bind();
  render();

  const tab = await activeTab();
  if (!tab || !/^https:\/\/chat\.deepseek\.com\//.test(tab.url || '')) {
    state.mode = 'wrongTab';
    state.messagesTried = true;
    state.sessionMissing = true;
    render();
    return;
  }
  state.tab = tab;

  if (!(await hasHostPermission())) {
    state.mode = 'noPermission';
    state.messagesTried = true;
    setMsg('ffPermHint');
    render();
    return;
  }

  const st = await send(tab.id, { type: 'status' });
  if (!st.ok) {
    state.mode = 'notInjected';
    state.messagesTried = true;
    if (st.error) setRawMsg(st.error, 'bad');
    render();
    return;
  }

  state.mode = 'ready';
  state.st = st;
  state.bridgeOutdated = !(typeof st.bridgeVersion === 'number' && st.bridgeVersion >= 6);

  const voicesRes = await send(tab.id, { type: 'voices' });
  state.voicesTried = true;
  const data = voicesRes.ok && voicesRes.data && voicesRes.data.code === 0
    && voicesRes.data.data && voicesRes.data.data.biz_code === 0
    ? voicesRes.data.data.biz_data
    : null;

  if (data && Array.isArray(data.voices)) {
    state.voices = data;
    const langs = new Set();
    data.voices.forEach((voice) => voiceLanguages(voice).forEach((code) => langs.add(code)));
    state.voiceLangs = [...langs];
    state.selectedVoice = data.current_voice_id || (data.voices[0] && data.voices[0].voice_id) || null;
    const ids = new Set(data.voices.map((v) => v.voice_id));
    if (!ids.has(state.assistantVoice)) state.assistantVoice = state.selectedVoice;
    if (!ids.has(state.userVoice)) state.userVoice = state.selectedVoice;
    reconcileVoiceLang();
  } else {
    const detail = voicesRes.ok ? (voicesRes.data && (voicesRes.data.data || voicesRes.data)) : voicesRes.error;
    setMsg('voicesFailed', { err: shortJson(detail) }, 'bad');
  }

  state.sessionMissing = !/\/a\/chat\/s\//.test(st.href || '');
  if (state.bridgeOutdated) {
    state.messagesTried = true;
    setAudioMsg('bridgeOutdated', null, 'bad');
  } else if (state.sessionMissing) {
    state.messagesTried = true;
  } else {
    await loadMessages(tab.id);
  }

  // 弹窗上一次关掉时可能还有导出任务在跑：接着显示进度
  const jobRes = await send(tab.id, { type: 'exportStatus' });
  if (jobRes && jobRes.ok && jobRes.data && jobRes.data.status === 'running') {
    state.downloading = true;
    state.exportJob = jobRes.data;
    state.wholeDialog = jobRes.data.total > 1;
    pollExport(jobRes.data.id);
  }

  render();
})();
