/**
 * content/content-script.js
 *
 * 隔离世界里的桥接脚本，只做三件事：
 *   1. 把 chrome.storage 里的规则推给主世界的 interceptor.js
 *   2. 接收 interceptor.js 上报的请求，攒批后转发给 Service Worker
 *   3. 扩展被重新加载后自我静默，不再向失效的 runtime 发消息
 *
 * 为什么不再注入 <script> 标签：
 * 通过 DOM 插入的脚本会被页面 CSP（script-src）拦截，在 GitHub、银行、多数 SPA
 * 上直接失效。interceptor.js 现在由 manifest 以 world: "MAIN" 声明注入，不受
 * 页面 CSP 约束，也不需要 web_accessible_resources。
 */
(function () {
  'use strict';

  /** 与主世界约定的 postMessage 频道标识 */
  const CHANNEL = 'vakao-interceptor';
  const STORAGE_KEY = 'interceptRules';

  /** 攒批参数：高频请求下把逐条消息压成少量消息，避免频繁唤醒 Service Worker */
  const FLUSH_INTERVAL_MS = 200;
  const FLUSH_SIZE = 50;

  let rules = [];
  let queue = [];
  let timer = null;
  let alive = true;

  /* ===== 与主世界通信 ===== */

  function postToMain(payload) {
    window.postMessage({ channel: CHANNEL, source: 'content', ...payload }, '*');
  }

  function pushRules(next) {
    rules = Array.isArray(next) ? next : [];
    postToMain({ type: 'RULES', rules });
  }

  /* ===== 上报队列 ===== */

  function enqueue(request) {
    if (!request) return;
    queue.push(request);
    if (queue.length >= FLUSH_SIZE) flush();
    else if (timer === null) timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (!alive || queue.length === 0) return;

    const list = queue;
    queue = [];
    try {
      // 带回调是为了消费 lastError，避免控制台出现 "Unchecked runtime.lastError"
      chrome.runtime.sendMessage({ type: 'REQUESTS', list }, () => {
        void chrome.runtime.lastError;
      });
    } catch (error) {
      // 扩展被重新加载或卸载后 chrome.runtime 会失效，此时静默停用
      alive = false;
      queue = [];
    }
  }

  /* ===== 生命周期 ===== */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.source !== 'main') return;
    if (data.type === 'READY') pushRules(rules);
    else if (data.type === 'CAPTURED') enqueue(data.request);
  });

  // 主世界脚本可能先于本脚本落地，此时它的 READY 会丢；因此这里主动拉一次规则，
  // 两种时序任意一种命中即可完成同步，不再需要定时重试。
  chrome.storage.local
    .get(STORAGE_KEY)
    .then((result) => pushRules(result[STORAGE_KEY]))
    .catch(() => {});

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY]) {
      pushRules(changes[STORAGE_KEY].newValue);
    }
  });
})();
