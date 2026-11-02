/* DeepSeek 朗读解锁 —— 注入到页面主世界（document_start，早于官方脚本）
 *
 * 官方判断「要不要显示朗读按钮」只有一句：
 *     ct().find(e => e.model_type === 当前模型)?.tts_feature
 * 其中 ct() 读的是远程配置缓存 localStorage["__ds_remote_feature_store_model"] 里
 * entries.model_configs.value[].tts_feature。
 *
 * 配置的加载顺序是「先从 localStorage 读进内存 → 再从服务端拉一次可能覆盖」，
 * 而覆盖条件是 loadEntries() 里的 `服务端版本号 < 内存里的 remoteVersion`。
 * 所以这里只在【读】的时候动手：
 *   1) 给所有模型补上 tts_feature；
 *   2) 把 remoteVersion 抬高 DELTA，保证任何一次服务端下发都盖不掉它
 *      （抬高 1 是不够的：服务端版本号一旦正好等于抬高后的值就会覆盖掉补丁，
 *        表现为「第一次刷新没效果、再刷一次才行」——这个坑已修）；
 *   3) 反过来在【写】的时候把 DELTA 减回去，磁盘上始终是服务端真实版本号，
 *      这样关掉插件后官方配置能立刻恢复下发，不会被永久锁死。
 */
(() => {
  const KEY = '__ds_remote_feature_store_model';
  const DELTA = 1000;
  const origGetItem = Storage.prototype.getItem;
  const origSetItem = Storage.prototype.setItem;

  function bump(raw) {
    if (!raw) return raw;
    let store;
    try { store = JSON.parse(raw); } catch { return raw; }
    const list = store && store.entries && store.entries.model_configs && store.entries.model_configs.value;
    if (!Array.isArray(list)) return raw;

    for (const cfg of list) {
      if (cfg && !cfg.tts_feature) cfg.tts_feature = { unlocked: true };
    }
    const v = typeof store.remoteVersion === 'number' ? store.remoteVersion : 0;
    store.remoteVersion = v + DELTA;
    return JSON.stringify(store);
  }

  function unbump(value) {
    if (typeof value !== 'string') return value;
    let store;
    try { store = JSON.parse(value); } catch { return value; }
    if (!store || typeof store.remoteVersion !== 'number' || store.remoteVersion < DELTA) return value;
    const list = store.entries && store.entries.model_configs && store.entries.model_configs.value;
    if (!Array.isArray(list)) return value;
    store.remoteVersion -= DELTA;
    return JSON.stringify(store);
  }

  Storage.prototype.getItem = function (key) {
    const value = origGetItem.call(this, key);
    if (key !== KEY) return value;
    try {
      const out = bump(value);
      if (out !== value) {
        document.documentElement.setAttribute('data-ds-tts-unlock', '1');
        window.postMessage({ __dsTtsUnlock: 'hydrated' }, '*');
      }
      return out;
    } catch {
      return value;
    }
  };

  Storage.prototype.setItem = function (key, value) {
    if (key === KEY) {
      try { value = unbump(value); } catch { /* 原样写回 */ }
    }
    return origSetItem.call(this, key, value);
  };

  /* 会话历史兜底：页面自己拉 /chat/history_messages 时顺手存一份，
   * 隔离世界（bridge.js）取不到时可以用它，避免接口参数/版本差异导致空列表。
   */
  let capturedMessages = null; // { sessionId, map: Map<id, message>, order: string[] }

  function sessionOf(url) {
    try {
      const m = String(url || '').match(/[?&]chat_session_id=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }

  function captureHistory(url, json) {
    try {
      const biz = json && json.data && json.data.biz_data;
      const list = biz && (biz.chat_messages || biz.messages);
      if (!Array.isArray(list)) return;
      const sessionId = sessionOf(url);
      // 换会话就重新收集；同一会话的 MERGE 增量按 message_id 合并
      if (!capturedMessages || capturedMessages.sessionId !== sessionId) {
        capturedMessages = { sessionId, map: new Map(), order: [] };
      }
      for (const m of list) {
        const id = m && (m.message_id != null ? m.message_id : m.id);
        if (id == null) continue;
        const key = String(id);
        if (!capturedMessages.map.has(key)) capturedMessages.order.push(key);
        capturedMessages.map.set(key, m);
      }
      while (capturedMessages.order.length > 200) {
        capturedMessages.map.delete(capturedMessages.order.shift());
      }
    } catch { /* 忽略 */ }
  }

  function capturedList() {
    if (!capturedMessages) return null;
    return capturedMessages.order.map((key) => capturedMessages.map.get(key)).filter(Boolean);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const promise = origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/v0/chat/history_messages')) {
          promise.then((res) => {
            try {
              res.clone().json().then((json) => captureHistory(url, json)).catch(() => {});
            } catch { /* body 已被消费 */ }
          }, () => {});
        }
      } catch { /* 忽略 */ }
      return promise;
    };
  }

  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { this.__dsTtsUrl = String(url || ''); } catch { /* 忽略 */ }
    return origXhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (String(this.__dsTtsUrl || '').includes('/api/v0/chat/history_messages')) {
        this.addEventListener('load', () => {
          try { captureHistory(this.__dsTtsUrl, JSON.parse(this.responseText)); } catch { /* 忽略 */ }
        });
      }
    } catch { /* 忽略 */ }
    return origXhrSend.apply(this, args);
  };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.__dsTtsUnlock !== 'getMessages') return;
    window.postMessage({
      __dsTtsUnlock: 'messages',
      sessionId: capturedMessages ? capturedMessages.sessionId : null,
      messages: capturedList(),
    }, '*');
  });

  document.documentElement.setAttribute('data-ds-tts-unlock', '1');
  window.postMessage({ __dsTtsUnlock: 'installed' }, '*');
})();
