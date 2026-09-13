/* DeepSeek 朗读解锁 —— 隔离世界脚本：给弹窗当后端，并做接口直连
 *
 * 它能读到本页 localStorage（同源共享）里的 userToken，所以可以在页面上下文里
 * 直接调官方接口：音色列表 / 切音色 / 取 TTS 票据。
 */

const KEY = '__ds_remote_feature_store_model';

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

// 跨浏览器：Firefox 用 browser.*（Promise），Chrome/Edge 用 chrome.*
// 注意：下面已有一个叫 api() 的取接口函数，所以这里叫 ext
const ext = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

ext.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      const tk = token();
      if (msg.type === 'status') {
        reply({
          ok: true,
          installed: document.documentElement.getAttribute('data-ds-tts-unlock') === '1',
          hasToken: !!tk,
          gray: grayInfo(),
          href: location.href,
        });
      } else if (msg.type === 'voices') {
        reply({ ok: true, data: await api('/api/v0/chat/tts/voices', {}, tk) });
      } else if (msg.type === 'setVoice') {
        reply({ ok: true, data: await api('/api/v0/chat/tts/voice', { method: 'POST', body: JSON.stringify({ voice_id: msg.voiceId }) }, tk) });
      } else if (msg.type === 'ticket') {
        reply({ ok: true, data: await api('/api/v0/auth/ticket', { method: 'POST', body: JSON.stringify({ scope: 'tts' }) }, tk) });
      } else if (msg.type === 'reset') {
        // 清掉本地配置缓存：下次加载会从服务端重新拉真值，缓存里的补丁一起消失
        localStorage.removeItem(KEY);
        reply({ ok: true });
        setTimeout(() => location.reload(), 120);
      } else {
        reply({ ok: false, error: 'unknown message: ' + msg.type });
      }
    } catch (e) {
      reply({ ok: false, error: String(e) });
    }
  })();
  return true; // 异步回复
});
