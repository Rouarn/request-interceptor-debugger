/**
 * background/service-worker.js
 *
 * MV3 Service Worker 只做三件事：
 *   1. 把 content script 批量上报的请求记录转发给已打开的侧边栏（并补上来源 tabId）
 *   2. 维护图标上的徽标数字（启用中的规则数）
 *   3. 打开工具栏图标时拉起侧边栏
 *
 * 这里刻意不保存任何业务状态：
 * Service Worker 会在空闲约 30 秒后被浏览器回收，任何放在模块作用域的
 * rules / capturedRequests 都会凭空消失。规则以 chrome.storage.local 为唯一
 * 来源（侧边栏直接读写），请求日志由侧边栏自己持有，SW 重启不会影响任何数据。
 */

/** chrome.storage.local 中规则列表的键名（沿用旧键，避免已有规则丢失） */
const STORAGE_KEY = 'interceptRules';

/* ===== 生命周期 ===== */

chrome.runtime.onInstalled.addListener(() => {
  // 点击工具栏图标直接打开侧边栏，省掉手写 onClicked + sidePanel.open
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch?.(() => {});
  refreshBadge();
});

// 浏览器重启后徽标会被清空，需要重新回填
chrome.runtime.onStartup.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
  updateBadge(changes[STORAGE_KEY].newValue);
});

/* ===== 消息转发 ===== */

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'REQUESTS') return;
  if (!Array.isArray(message.list) || message.list.length === 0) return;

  // 只有这里能拿到来源标签页 id（content script 自己看不到），而且不需要 tabs 权限。
  // 侧边栏用它来把「重放」发回原标签页的页面上下文。
  const tabId = sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
  const list = tabId === null ? message.list : message.list.map((item) => ({ ...item, tabId }));
  forwardToPanel(list);
});

/**
 * 仅在侧边栏确实存在时才转发。
 *
 * 侧边栏关闭后没有任何接收方，逐条广播只会让 SW 反复被唤醒并抛
 * "Receiving end does not exist"。getContexts 是同步查询运行上下文的无状态
 * 方案，不需要维护"面板是否打开"的内存标志（那个标志本身也会被 SW 回收重置）。
 */
async function forwardToPanel(list) {
  let contexts;
  try {
    contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
  } catch (error) {
    return;
  }
  if (contexts.length === 0) return;
  chrome.runtime.sendMessage({ type: 'REQUESTS', list }).catch(() => {});
}

/* ===== 徽标 ===== */

function refreshBadge() {
  chrome.storage.local
    .get(STORAGE_KEY)
    .then((result) => updateBadge(result[STORAGE_KEY]))
    .catch(() => {});
}

function updateBadge(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const count = list.filter((rule) => rule && rule.enabled !== false).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
  }
}
