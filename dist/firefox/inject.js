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

  document.documentElement.setAttribute('data-ds-tts-unlock', '1');
  window.postMessage({ __dsTtsUnlock: 'installed' }, '*');
})();
