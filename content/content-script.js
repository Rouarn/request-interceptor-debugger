/**
 * content/content-script.js
 *
 * 隔离世界里的桥接脚本，只做四件事：
 *   1. 把 chrome.storage 里的规则推给主世界的 interceptor.js
 *   2. 接收 interceptor.js 上报的请求，攒批后转发给 Service Worker
 *   3. 把侧边栏的重放请求转给主世界执行，并把结果回传
 *   4. 扩展被重新加载后自我静默，不再向失效的 runtime 发消息
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

  /** 重放：主世界执行，这里做超时兜底，避免侧边栏一直停在"重放中" */
  const REPLAY_TIMEOUT_MS = 20000;

  let rules = [];
  let queue = [];
  let timer = null;
  let alive = true;
  let replaySeq = 0;

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
    // 扩展已失效：队列再攒也没人接收，直接丢弃，避免页面里无限增长
    if (!alive) {
      queue = [];
      return;
    }
    if (queue.length === 0) return;

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

  /* ===== 重放 ===== */

  const pendingReplays = new Map();

  function replay(request) {
    const id = `replay-${Date.now()}-${(replaySeq += 1)}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingReplays.delete(id);
        reject(new Error('页面 20 秒内没有返回重放结果'));
      }, REPLAY_TIMEOUT_MS);
      pendingReplays.set(id, { resolve, timeout });
      postToMain({ type: 'REPLAY', id, request });
    });
  }

  function resolveReplay(id, result) {
    const pending = pendingReplays.get(id);
    if (!pending) return;
    pendingReplays.delete(id);
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'REPLAY_REQUEST') return;
    replay(message.request).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: String((error && error.message) || error) }),
    );
    return true; // 异步回包
  });

  /* ===== 生命周期 ===== */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.source !== 'main') return;
    if (data.type === 'READY') pushRules(rules);
    else if (data.type === 'CAPTURED') enqueue(data.request);
    else if (data.type === 'REPLAY_RESULT') resolveReplay(data.id, data.result);
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
