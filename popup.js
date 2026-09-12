/* 弹窗：显示注入状态 / 真实灰度状态 / 切换朗读音色 */

const $ = (id) => document.getElementById(id);
const VOICE_ZH = { mira: '贝壳 · 百变活泼', echo: '白浪 · 明朗坚定', stella: '海星 · 俏皮甜美', tide: '暗潮 · 低沉浑厚' };

function setMsg(text, cls) {
  $('msg').innerHTML = text ? `<span class="${cls || 'muted'}">${text}</span>` : '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(tabId, payload) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: 'empty response' });
    });
  });
}

(async () => {
  const tab = await activeTab();
  if (!tab || !/^https:\/\/chat\.deepseek\.com\//.test(tab.url || '')) {
    $('dot').className = 'dot off';
    $('page').innerHTML = '当前标签页不是 <code>chat.deepseek.com</code>，切过去再点我。';
    $('gray').textContent = '';
    return;
  }

  const st = await send(tab.id, { type: 'status' });
  if (!st.ok) {
    $('dot').className = 'dot off';
    $('page').innerHTML = '还没注入成功：<strong>刷新一下页面</strong>（装完插件后必须刷新）。';
    setMsg(st.error || '', 'bad');
    return;
  }

  $('dot').className = 'dot ' + (st.installed ? 'on' : 'off');
  $('page').innerHTML = st.installed
    ? '解锁状态：<span class="ok">已生效</span>　' + (st.hasToken ? '已登录' : '<span class="bad">未登录</span>')
    : '<span class="bad">未生效</span>（刷新页面试试）';

  const g = st.gray;
  $('reset').onclick = async () => {
    $('reset').disabled = true;
    setMsg('已清掉本地缓存，刷新中…');
    await send(tab.id, { type: 'reset' });
  };
  if (g && g.models) {
    const grayed = g.models.some((m) => m.gray);
    $('gray').innerHTML = grayed
      ? '账号灰度状态：<span class="ok">本来就有朗读</span>'
      : '账号灰度状态：<span class="muted">官方没灰度到你</span> —— 已由插件接管';
    $('gray').innerHTML += `<ul id="models">${g.models
      .map((m) => `<li>${m.model}${m.enabled ? '' : '（关闭）'} · tts_feature = ${m.gray}</li>`)
      .join('')}</ul>`;
  } else {
    $('gray').textContent = '还没拿到远程配置缓存，刷新一次页面。';
  }

  // 音色
  const vr = await send(tab.id, { type: 'voices' });
  const sel = $('voice'), save = $('save');
  const j = vr.ok ? vr.data : null;
  if (!j || j.code !== 0 || !j.data || j.data.biz_code !== 0) {
    sel.innerHTML = '<option>取音色失败</option>';
    setMsg('取音色列表失败：' + JSON.stringify(j || vr.error).slice(0, 160), 'bad');
    return;
  }
  const info = j.data.biz_data;
  sel.innerHTML = info.voices
    .map((v) => `<option value="${v.voice_id}"${v.voice_id === info.current_voice_id ? ' selected' : ''}>${VOICE_ZH[v.voice_id] || (v.name_i18n && v.name_i18n.zh) || v.voice_id}</option>`)
    .join('');
  sel.disabled = false;
  save.disabled = false;
  save.onclick = async () => {
    save.disabled = true;
    setMsg('切换中…');
    const r = await send(tab.id, { type: 'setVoice', voiceId: sel.value });
    const code = r.ok && r.data && r.data.code === 0 ? r.data.data.biz_code : null;
    if (code === 0) setMsg('已切换为 ' + (VOICE_ZH[sel.value] || sel.value), 'ok');
    else setMsg('切换失败：' + JSON.stringify((r.data && r.data.data) || r.error).slice(0, 160), 'bad');
    save.disabled = false;
  };
})();
