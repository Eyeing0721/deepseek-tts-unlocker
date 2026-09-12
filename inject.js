/* DeepSeek 朗读解锁 —— 注入到页面主世界（document_start，早于官方脚本）
 *
 * 官方判断「要不要显示朗读按钮」只有一句：
 *     ct().find(e => e.model_type === 当前模型)?.tts_feature
 * 其中 ct() 读的是远程配置缓存 localStorage["__ds_remote_feature_store_model"] 里
 * entries.model_configs.value[].tts_feature。
 *
 * 但配置是「先读 localStorage 进内存 → 再从服务端拉一次覆盖」的，光改磁盘没用：
 * 服务端返回的版本号只要 >= 本地版本号，loadEntries() 就会用真实配置覆盖内存。
 * 所以这里只在【读】的时候动手：
 *   1) 把所有模型的 tts_feature 补成真值；
 *   2) 把 remoteVersion 在内存里抬高 1，让服务端本次会话的配置覆盖不进来；
 *   3) 不拦截 setItem —— 磁盘上始终保留服务端原值，下次开页面照样能拿到最新模型/新功能。
 */
(() => {
  const KEY = '__ds_remote_feature_store_model';
  const origGetItem = Storage.prototype.getItem;

  function patch(raw) {
    if (!raw) return raw;
    let store;
    try { store = JSON.parse(raw); } catch { return raw; }
    const list = store && store.entries && store.entries.model_configs && store.entries.model_configs.value;
    if (!Array.isArray(list)) return raw;

    for (const cfg of list) {
      if (cfg && !cfg.tts_feature) cfg.tts_feature = { unlocked: true };
    }
    // 版本号抬高 1：足够挡住同一次会话里的服务端覆盖，又不会把后续版本彻底锁死
    const v = typeof store.remoteVersion === 'number' ? store.remoteVersion : 0;
    store.remoteVersion = v + 1;
    return JSON.stringify(store);
  }

  Storage.prototype.getItem = function (key) {
    const value = origGetItem.call(this, key);
    if (key !== KEY) return value;
    try {
      const out = patch(value);
      if (out !== value) {
        document.documentElement.setAttribute('data-ds-tts-unlock', '1');
        window.postMessage({ __dsTtsUnlock: 'hydrated' }, '*');
      }
      return out;
    } catch {
      return value;
    }
  };

  document.documentElement.setAttribute('data-ds-tts-unlock', '1');
  window.postMessage({ __dsTtsUnlock: 'installed' }, '*');
})();
