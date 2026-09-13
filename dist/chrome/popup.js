/* 弹窗：显示注入状态 / 真实灰度状态 / 切换朗读音色
 *
 * 跨浏览器：Firefox 用 browser.*（Promise 风格），Chrome / Edge 用 chrome.*
 * （Chrome MV3 的 tabs / permissions 同样支持 Promise，所以一套代码两边都能跑）
 */

const api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
const ORIGINS = ['https://chat.deepseek.com/*'];

const $ = (id) => document.getElementById(id);
const VOICE_ZH = { mira: '贝壳 · 百变活泼', echo: '白浪 · 明朗坚定', stella: '海星 · 俏皮甜美', tide: '暗潮 · 低沉浑厚' };

// 拼 HTML 前把服务端来的字符串转义掉
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function setMsg(text, cls) {
  $('msg').innerHTML = text ? `<span class="${cls || 'muted'}">${text}</span>` : '';
}

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

(async () => {
  const tab = await activeTab();
  if (!tab || !/^https:\/\/chat\.deepseek\.com\//.test(tab.url || '')) {
    $('dot').className = 'dot off';
    $('page').innerHTML = '当前标签页不是 <code>chat.deepseek.com</code>，切过去再点我。';
    $('gray').textContent = '';
    return;
  }

  if (!(await hasHostPermission())) {
    $('dot').className = 'dot off';
    $('page').innerHTML = '还差一步：<strong>允许本扩展访问 chat.deepseek.com</strong>';
    const grant = $('grant');
    grant.hidden = false;
    grant.onclick = async () => {
      grant.disabled = true;
      try {
        await api.permissions.request({ origins: ORIGINS });
      } catch (e) {
        setMsg('请求权限失败：' + e, 'bad');
        grant.disabled = false;
        return;
      }
      if (await hasHostPermission()) {
        setMsg('已授权，正在刷新页面…', 'ok');
        try { await api.tabs.reload(tab.id); } catch { /* 忽略 */ }
        setTimeout(() => window.close(), 500);
      } else {
        setMsg('没拿到授权。可以到 <code>about:addons</code> → 本扩展 → 权限，手动允许站点访问。', 'bad');
        grant.disabled = false;
      }
    };
    setMsg('Firefox 的站点访问权限是可选项，点上面的按钮授权即可。', 'muted');
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
      .map((m) => `<li>${esc(m.model)}${m.enabled ? '' : '（关闭）'} · tts_feature = ${m.gray}</li>`)
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
    setMsg('取音色列表失败：' + esc(JSON.stringify(j || vr.error).slice(0, 160)), 'bad');
    return;
  }
  const info = j.data.biz_data;
  sel.innerHTML = info.voices
    .map((v) => `<option value="${esc(v.voice_id)}"${v.voice_id === info.current_voice_id ? ' selected' : ''}>${esc(VOICE_ZH[v.voice_id] || (v.name_i18n && v.name_i18n.zh) || v.voice_id)}</option>`)
    .join('');
  sel.disabled = false;
  save.disabled = false;
  save.onclick = async () => {
    save.disabled = true;
    setMsg('切换中…');
    const r = await send(tab.id, { type: 'setVoice', voiceId: sel.value });
    const code = r.ok && r.data && r.data.code === 0 ? r.data.data.biz_code : null;
    if (code === 0) setMsg('已切换为 ' + (VOICE_ZH[sel.value] || sel.value), 'ok');
    else setMsg('切换失败：' + esc(JSON.stringify((r.data && r.data.data) || r.error).slice(0, 160)), 'bad');
    save.disabled = false;
  };
})();
