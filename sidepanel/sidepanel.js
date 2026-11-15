/**
 * sidepanel/sidepanel.js
 *
 * 侧边栏的全部交互逻辑，原生 JS 实现（不再依赖 jQuery）。
 *
 * 数据归属：
 *   - 规则：chrome.storage.local 是唯一来源，本面板直接读写，不做内存缓存写回
 *   - 请求日志：只存在本面板内存里。面板关闭即丢弃，这是刻意取舍——日志本来
 *     只在"打开面板调试"时才有意义，放进存储反而会拖慢每次请求。
 *
 * 渲染策略：
 *   - 新请求批量到达，增量插到列表顶部，不整表重绘，并补偿滚动位置
 *   - 面板不可见时只标脏，切回来再渲染
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'interceptRules';
  const MAX_REQUESTS = 500;
  /** 超过这个长度的响应体不再解析成 JSON 树，直接按原始文本展示 */
  const MAX_PARSE_CHARS = 100 * 1024;
  /** 这些方法重放会真实写服务端，可能产生副作用，执行前必须二次确认 */
  const NON_IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  /** HAR 里对"采集面"的统一说明 */
  const HAR_SCOPE_NOTE =
    '仅包含页面 JS 发起的 fetch/XHR 请求，不含图片、脚本、字体等资源请求；请求头仅包含页面 JS 显式设置的字段，浏览器自动附加的 Cookie/User-Agent/Accept/Sec-Fetch-* 等无法获取，重放时需自行补登录态；响应体为浏览器解码后的文本，可能被截断或未采集，详见各 entry 的 comment。';

  /** @type {Array<Object>} 请求记录，最新在前 */
  let requests = [];
  /** @type {Array<Object>} 规则列表，与 chrome.storage 保持同步 */
  let rules = [];

  let detailRequest = null;
  let detailTab = 'overview';
  let bodyMode = 'parsed';
  let responseMode = 'parsed';
  /** 面板隐藏时是否还有待渲染的新数据 */
  let pendingRender = false;
  let toastTimer = null;

  const el = (id) => document.getElementById(id);
  const requestList = el('requestList');
  const ruleList = el('ruleList');

  boot();

  /* ===================================================================
   *  初始化
   * =================================================================== */

  function boot() {
    bindTabs();
    bindFilters();
    bindModals();
    bindRulePanel();
    bindRequestDetail();
    bindExport();
    bindShortcuts();
    listenForUpdates();
    loadRules();
    renderRequests();
  }

  function bindTabs() {
    document.querySelectorAll('.tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });
    el('openRules').addEventListener('click', () => activateTab('rules'));
  }

  function activateTab(name) {
    document.querySelectorAll('.tabs .tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.tab === name);
    });
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.classList.toggle('active', panel.id === `${name}Panel`);
    });
    if (name === 'requests' && pendingRender) renderRequests();
  }

  function requestsVisible() {
    return el('requestsPanel').classList.contains('active');
  }

  function bindFilters() {
    ['filterUrl', 'filterMethod', 'filterStatus'].forEach((id) => {
      el(id).addEventListener('input', renderRequests);
      el(id).addEventListener('change', renderRequests);
    });
  }

  function bindExport() {
    el('exportHar').addEventListener('click', exportHarAll);
    el('exportDetailHar').addEventListener('click', exportHarSingle);
  }

  function bindModals() {
    document.addEventListener('click', (event) => {
      const closer = event.target.closest('.modal-close');
      if (closer) {
        closer.closest('.modal').classList.add('hidden');
        return;
      }
      if (event.target.classList.contains('modal')) event.target.classList.add('hidden');
    });
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      document.querySelectorAll('.modal:not(.hidden)').forEach((modal) => modal.classList.add('hidden'));
    });
  }

  /* ===================================================================
   *  数据接入
   * =================================================================== */

  function listenForUpdates() {
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (!message || message.type !== 'REQUESTS') return;
      // content script 的 sendMessage 也会直接投递到扩展页面（此时 sender.tab 有值），
      // Service Worker 又转发同一批，两条路都收就会把每条请求记两遍。
      // 这里只认 SW 转发（无 sender.tab），保留"面板关闭即丢弃"的唯一入口。
      if (sender.tab) return;
      ingest(message.list);
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY]) {
        rules = normalizeRules(changes[STORAGE_KEY].newValue);
        renderRules();
      }
    });
  }

  function loadRules() {
    chrome.storage.local
      .get(STORAGE_KEY)
      .then((result) => {
        rules = normalizeRules(result[STORAGE_KEY]);
        renderRules();
      })
      .catch(() => {
        rules = [];
        renderRules();
      });
  }

  function storeRules(next) {
    return chrome.storage.local.set({ [STORAGE_KEY]: next }).catch((error) => {
      toast(`保存失败：${error.message}`, true);
    });
  }

  /* ===================================================================
   *  请求列表
   * =================================================================== */

  function ingest(list) {
    if (!Array.isArray(list) || list.length === 0) return;

    // 上报按完成顺序到达，取反后才是"最新在前"
    const fresh = list.filter(Boolean).reverse().map((item) => ({ ...item, id: uid() }));
    requests = fresh.concat(requests).slice(0, MAX_REQUESTS);

    if (!requestsVisible()) {
      pendingRender = true;
      return;
    }
    // 过滤状态下条数与顺序都不固定，直接重绘更简单可靠
    if (hasFilters() || !requestList.querySelector('.request-item')) {
      renderRequests();
      return;
    }

    const prevTop = requestList.scrollTop;
    const prevHeight = requestList.scrollHeight;
    const fragment = document.createElement('template');
    fragment.innerHTML = fresh.map(requestRow).join('');
    requestList.insertBefore(fragment.content, requestList.firstChild);

    const rows = requestList.querySelectorAll('.request-item');
    for (let i = MAX_REQUESTS; i < rows.length; i++) rows[i].remove();

    // 用户正在往下看历史记录时，插入新行不应把视野顶走
    if (prevTop > 0) requestList.scrollTop = prevTop + (requestList.scrollHeight - prevHeight);
    updateListCount();
  }

  function renderRequests() {
    updateListCount();
    if (!requestsVisible()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;

    const list = filteredRequests();
    if (list.length === 0) {
      requestList.innerHTML = `<div class="empty-state">${hasFilters() ? '没有匹配的请求' : '暂无捕获的请求'}<span class="empty-hint">侧边栏打开期间才会记录请求</span></div>`;
      return;
    }
    requestList.innerHTML = list.map(requestRow).join('');
  }

  /** 工具条上的计数：有筛选时同时显示"命中 / 总数"，让导出的范围一目了然 */
  function updateListCount() {
    const total = requests.length;
    const shown = hasFilters() ? filteredRequests().length : total;
    el('listCount').textContent = shown === total ? `${total} 条记录` : `${shown} / ${total} 条记录`;
  }

  function requestRow(req) {
    const method = String(req.method || 'GET');
    return `<div class="request-item${req.intercepted ? ' intercepted' : ''}" data-id="${req.id}">
      <div class="request-item-header">
        <span class="request-method method-${method.toLowerCase()}">${esc(method)}</span>
        <span class="request-url" title="${esc(req.url)}">${esc(shortUrl(req.url))}</span>
        <span class="request-status ${statusClass(req.status)}">${req.status}</span>
        <span class="request-duration">${req.duration}ms</span>
      </div>
      <div class="request-time">${formatTime(req.timestamp)}</div>
    </div>`;
  }

  function filteredRequests() {
    const keyword = el('filterUrl').value.trim().toLowerCase();
    const method = el('filterMethod').value;
    const statusGroup = el('filterStatus').value;
    if (!keyword && !method && !statusGroup) return requests;

    return requests.filter((req) => {
      if (keyword && !String(req.url).toLowerCase().includes(keyword)) return false;
      if (method && req.method !== method) return false;
      if (statusGroup && !String(req.status).startsWith(statusGroup.charAt(0))) return false;
      return true;
    });
  }

  function hasFilters() {
    return Boolean(el('filterUrl').value.trim() || el('filterMethod').value || el('filterStatus').value);
  }

  function bindRequestDetail() {
    requestList.addEventListener('click', (event) => {
      const row = event.target.closest('.request-item');
      if (!row) return;
      const request = requests.find((item) => item.id === row.dataset.id);
      if (request) openDetail(request);
    });

    el('clearRequests').addEventListener('click', () => {
      requests = [];
      renderRequests();
    });

    el('replayRequest').addEventListener('click', replayRequest);

    document.querySelector('.detail-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.detail-tab');
      if (!tab) return;
      detailTab = tab.dataset.detailTab;
      document.querySelectorAll('.detail-tab').forEach((item) => {
        item.classList.toggle('active', item === tab);
      });
      renderDetail();
    });

    el('copyCurl').addEventListener('click', copyAsCurl);
    el('copyResponse').addEventListener('click', () => {
      if (detailRequest) copy(detailRequest.responseBody || '', '响应体已复制');
    });
    el('mockFromRequest').addEventListener('click', () => createRuleFromRequest('mock'));
    el('modifyFromRequest').addEventListener('click', () => createRuleFromRequest('modify'));
  }

  /* ===================================================================
   *  请求详情
   * =================================================================== */

  function openDetail(request) {
    detailRequest = request;
    detailTab = 'overview';
    document.querySelectorAll('.detail-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.detailTab === 'overview');
    });
    renderDetail();
    el('requestDetail').classList.remove('hidden');
  }

  function renderDetail() {
    if (!detailRequest) return;
    const container = el('detailContent');
    const req = detailRequest;

    if (detailTab === 'headers') {
      const rows = Object.entries(req.requestHeaders || {});
      container.innerHTML = rows.length
        ? rows.map(([key, value]) => detailRow(key, String(value))).join('')
        : '<div class="empty-state">无请求头</div>';
      return;
    }
    if (detailTab === 'body') {
      renderPayload(container, req.requestBody, 'body', req.requestBodyNote);
      return;
    }
    if (detailTab === 'response') {
      renderPayload(container, req.responseBody, 'response', req.responseBodyNote);
      return;
    }

    const meta = [];
    meta.push(detailRow('方法', req.method));
    if (req.finalUrl && req.finalUrl !== req.url) {
      meta.push(detailRow('原始 URL', req.url));
      meta.push(detailRow('实际 URL', req.finalUrl));
    } else {
      meta.push(detailRow('URL', req.url));
    }
    meta.push(detailRow('状态', `${req.status} ${req.statusText || ''}`.trim()));
    meta.push(detailRow('耗时', `${req.duration}ms`));
    meta.push(detailRow('类型', req.type));
    meta.push(detailRow('拦截', req.intercepted ? `是 · ${ruleLabel(req)}` : '否'));
    meta.push(detailRow('时间', formatTime(req.timestamp)));
    container.innerHTML = meta.join('') + renderReplay(req);
  }

  function ruleLabel(req) {
    const name = req.action === 'mock' ? 'Mock' : req.action === 'modify' ? '修改' : '重定向';
    return req.ruleName ? `${name}（${req.ruleName}）` : name;
  }

  function detailRow(label, value) {
    return `<div class="detail-row"><span class="detail-label">${esc(label)}</span><span class="detail-value">${esc(value)}</span></div>`;
  }

  /**
   * 渲染请求体/响应体。
   * 请求体和响应体原本是两段几乎相同的代码，这里合并成一份，靠 modeKey 区分视图状态。
   * note 是拦截器给出的"体不完整"原因（截断/二进制/流式），为空表示体是完整的。
   */
  function renderPayload(container, text, modeKey, note) {
    const label = modeKey === 'body' ? '请求体' : '响应体';
    if (!text) {
      container.innerHTML = `<div class="empty-state">${note ? esc(note) : `无${label}`}</div>`;
      return;
    }

    const mode = modeKey === 'body' ? bodyMode : responseMode;
    let html = `<div class="body-toggle">
      <button class="body-toggle-btn${mode === 'parsed' ? ' active' : ''}" data-view="parsed">解析</button>
      <button class="body-toggle-btn${mode === 'raw' ? ' active' : ''}" data-view="raw">原始</button>
    </div>`;
    if (note) html += `<div class="empty-hint">${esc(note)}</div>`;

    if (mode === 'raw' || text.length > MAX_PARSE_CHARS) {
      html += `<div class="body-raw">${esc(prettyJson(text))}</div>`;
      if (text.length > MAX_PARSE_CHARS) {
        html += '<div class="empty-hint">内容较大，已按原始文本显示</div>';
      }
    } else {
      const parsed = tryParseJson(text);
      if (parsed !== undefined) {
        html += jsonTree(parsed, 0);
      } else {
        const pairs = modeKey === 'body' ? parseFormBody(text) : [];
        html += pairs.length
          ? pairs.map(([key, value]) => detailRow(key, value)).join('')
          : `<div class="body-raw">${esc(text)}</div>`;
      }
    }

    container.innerHTML = html;
    container.querySelectorAll('.body-toggle-btn').forEach((button) => {
      button.addEventListener('click', () => {
        if (modeKey === 'body') bodyMode = button.dataset.view;
        else responseMode = button.dataset.view;
        renderPayload(container, text, modeKey, note);
      });
    });
  }

  function jsonTree(value, depth) {
    if (value === null || typeof value !== 'object') {
      return `<div class="json-line">${primitiveHtml(value)}</div>`;
    }

    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((item, index) => [String(index), item]) : Object.entries(value);
    if (entries.length === 0) {
      return `<span class="json-bracket">${isArray ? '[]' : '{}'}</span>`;
    }

    const items = entries
      .map(([key, child]) => {
        const keyHtml = isArray
          ? `<span class="json-index">[${key}]</span>`
          : `<span class="json-key">"${esc(key)}"</span>`;
        if (child !== null && typeof child === 'object') {
          const isEmpty = Array.isArray(child) ? child.length === 0 : Object.keys(child).length === 0;
          const childHtml = isEmpty
            ? `<span class="json-bracket">${Array.isArray(child) ? '[]' : '{}'}</span>`
            : jsonTree(child, depth + 1);
          return `<div class="json-line">${keyHtml}<span class="json-colon">: </span>${childHtml}</div>`;
        }
        return `<div class="json-line">${keyHtml}<span class="json-colon">: </span>${primitiveHtml(child)}</div>`;
      })
      .join('');

    const open = isArray ? '[' : '{';
    const close = isArray ? ']' : '}';
    // 顶层始终展开，深层的大对象默认折叠，避免大响应把面板撑爆
    if (depth >= 1 && entries.length > 10) {
      return `<details class="json-details${depth < 2 ? ' open' : ''}"><summary class="json-summary">${open} … ${entries.length} 项 ${close}</summary><div class="json-children">${items}</div></details>`;
    }
    return `<span class="json-bracket">${open}</span><div class="json-children">${items}</div><span class="json-bracket">${close}</span>`;
  }

  function primitiveHtml(value) {
    if (value === null) return '<span class="json-null">null</span>';
    if (typeof value === 'string') return `<span class="json-string">"${esc(value)}"</span>`;
    if (typeof value === 'number') return `<span class="json-number">${value}</span>`;
    if (typeof value === 'boolean') return `<span class="json-bool">${value}</span>`;
    return `<span class="json-null">${esc(String(value))}</span>`;
  }

  function tryParseJson(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return undefined;
    }
  }

  function prettyJson(text) {
    const parsed = tryParseJson(text);
    return parsed === undefined ? text : JSON.stringify(parsed, null, 2);
  }

  function parseFormBody(text) {
    if (!text.includes('=') || text.includes('{')) return [];
    try {
      return [...new URLSearchParams(text).entries()];
    } catch (error) {
      return [];
    }
  }

  /* ===================================================================
   *  复制
   * =================================================================== */

  function copyAsCurl() {
    const req = detailRequest;
    if (!req) return;

    const lines = [`curl -X ${req.method} '${req.finalUrl || req.url}'`];
    for (const [name, value] of Object.entries(req.requestHeaders || {})) {
      lines.push(`  -H '${name}: ${value}'`);
    }
    if (req.requestBody) {
      lines.push(`  --data-raw '${String(req.requestBody).replace(/'/g, "'\\''")}'`);
    }
    copy(lines.join(' \\\n'), 'cURL 命令已复制');
  }

  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch (error) {
      toast(`复制失败：${error.message}`, true);
    }
  }

  /* ===================================================================
   *  单条重放
   *
   *  不申请额外权限：重放请求交给记录所属标签页的主世界脚本发出
   *  （credentials: 'include'），Cookie / UA / Sec-Fetch-* 由浏览器自己补。
   *  主世界用保存下来的原生 fetch 直接发，不会走拦截器，因此不会产生新记录。
   * =================================================================== */

  async function replayRequest() {
    const req = detailRequest;
    if (!req || req.replaying) return;

    // 旧记录没有 tabId，或者在升级前捕获：明确告知，不做猜测
    if (typeof req.tabId !== 'number') {
      return toast('这条记录没有来源标签页信息（旧版本记录），无法重放', true);
    }
    if (req.requestBodyNote) {
      return toast(`原请求体未被完整采集（${req.requestBodyNote}），无法忠实重放`, true);
    }

    const recordUrl = req.finalUrl || req.url;
    const recordOrigin = originOf(recordUrl);
    if (!recordOrigin) return toast('记录 URL 无法解析，无法重放', true);

    let tab;
    try {
      tab = await chrome.tabs.get(req.tabId);
    } catch (error) {
      return toast('来源标签页已关闭，无法重放', true);
    }

    const tabOrigin = originOf(tab && tab.url);
    if (!tabOrigin) {
      return toast(`无法确认标签页地址（${(tab && tab.url) || '未知'}），无法重放`, true);
    }
    if (tabOrigin !== recordOrigin) {
      return toast(`当前标签页是 ${tabOrigin}，与记录请求的 ${recordOrigin} 不同源，无法继承登录态`, true);
    }

    // 非幂等请求会真实写服务端，先说清后果；GET / HEAD 只读，不打扰用户
    const method = String(req.method || 'GET').toUpperCase();
    if (
      NON_IDEMPOTENT_METHODS.has(method) &&
      !confirm(
        `即将重放 ${method} 请求：\n\n${recordUrl}\n\n该请求会真实发送到服务端，可能产生副作用（例如创建、修改或删除数据）。确定继续？`,
      )
    ) {
      return;
    }

    const button = el('replayRequest');
    req.replaying = true;
    button.disabled = true;
    button.textContent = '重放中…';

    try {
      const response = await chrome.tabs.sendMessage(req.tabId, {
        type: 'REPLAY_REQUEST',
        request: {
          method: req.method,
          url: recordUrl,
          headers: req.requestHeaders || {},
          body: req.requestBody || '',
        },
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || '页面没有返回重放结果');
      }
      req.replay = { ...response.result, at: new Date().toISOString() };
    } catch (error) {
      req.replay = { ok: false, error: describeReplayError(error), at: new Date().toISOString() };
    } finally {
      req.replaying = false;
      button.disabled = false;
      button.textContent = '重放';
    }

    renderDetail();
    const replay = req.replay;
    if (replay.ok) {
      const verdict = compareReplay(req, replay).verdict;
      toast(`重放完成：${replay.status} · 内容${verdict}`);
    } else {
      toast(`重放失败：${replay.error}`, true);
    }
  }

  /** chrome.tabs.sendMessage 在注入失败时抛的是英文错误，这里翻成人话 */
  function describeReplayError(error) {
    const message = String((error && error.message) || error || '');
    if (/Receiving end does not exist|Could not establish connection/i.test(message)) {
      return '该标签页没有注入拦截脚本（chrome:// 等受限页面），无法重放';
    }
    if (/message channel closed|The message port closed/i.test(message)) {
      return '页面在重放过程中被刷新或关闭';
    }
    return message || '重放失败';
  }

  /** 重放结果挂在原记录上，不新增列表项，所以列表条数不变 */
  function renderReplay(req) {
    const replay = req.replay;
    if (!replay) return '';
    const title = `<div class="replay-block-title"><span>重放结果</span><span class="replay-time">${esc(formatTime(replay.at))}</span></div>`;

    if (!replay.ok) {
      return `<div class="replay-block">${title}${detailRow('失败', replay.error || '未知错误')}</div>`;
    }

    const originalBytes = byteLength(req.responseBody || '');
    const statusSame = Number(replay.status) === Number(req.status);
    const lengthSame = replay.bodyLength === originalBytes;
    const comparison = compareReplay(req, replay);
    const detail = comparison.detail ? `${comparison.verdict}（${comparison.detail}）` : comparison.verdict;

    return `<div class="replay-block">${title}
      ${detailRow('状态码', `${req.status} → ${replay.status}（${statusSame ? '相同' : '不同'}）`)}
      ${detailRow('耗时', `${req.duration}ms → ${replay.duration}ms`)}
      ${detailRow('响应体', `${originalBytes}B → ${replay.bodyLength}B（${lengthSame ? '相同' : '不同'}）`)}
      ${detailRow('内容', detail)}
    </div>`;
  }

  /**
   * 只给"高层结论"：相同 / 不同 / 无法比较。
   * 任何一侧的体不完整（截断、二进制、流式未采集）都不硬比，避免给出错误结论。
   */
  function compareReplay(req, replay) {
    if (req.responseBodyNote || replay.bodyNote) {
      return { verdict: '无法比较', detail: req.responseBodyNote || replay.bodyNote };
    }
    return { verdict: sameBody(req.responseBody || '', replay.bodyText || '') ? '相同' : '不同', detail: '' };
  }

  /** JSON 先规范化再比，避免键顺序、空白差异被误判成"不同" */
  function sameBody(left, right) {
    if (left === right) return true;
    const a = tryParseJson(left);
    const b = tryParseJson(right);
    if (a !== undefined && b !== undefined) return stableStringify(a) === stableStringify(b);
    return false;
  }

  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  function originOf(url) {
    try {
      return new URL(url).origin;
    } catch (error) {
      return '';
    }
  }

  /* ===================================================================
   *  HAR 导出
   *
   *  数据源就是侧边栏内存里的记录，不额外采集任何东西。产出的 HAR 1.2 只覆盖
   *  fetch/XHR，且体可能被截断，这些信息通过 log.creator.comment 与 entry.comment
   *  写进文件本身，避免被当成 DevTools 导出的完整 HAR。
   * =================================================================== */

  function exportHarAll() {
    const list = filteredRequests();
    if (list.length === 0) return toast('当前没有可导出的请求', true);
    exportHar(list);
    toast(`已导出 ${list.length} 条请求（HAR 1.2）`);
  }

  function exportHarSingle() {
    if (!detailRequest) return;
    exportHar([detailRequest]);
    toast('已导出 1 条请求（HAR 1.2）');
  }

  /** 两个导出入口共用同一份序列化与下载参数，避免缩进/类型在两处漂移 */
  function exportHar(records) {
    downloadFile(harFileName(), JSON.stringify(buildHar(records), null, 2), 'application/json');
  }

  /**
   * 记录在侧边栏里是按"完成时间"倒序排的，直接翻转并不等于按开始时间正序
   * （先发但慢的请求会排到后面），所以这里按 startedDateTime 显式排序，
   * 保证 entries 严格时间正序。ISO 8601 字符串可直接字典序比较。
   */
  function buildHar(records) {
    const manifest = chrome.runtime.getManifest();
    const entries = records.map(harEntry).sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
    return {
      log: {
        version: '1.2',
        creator: {
          name: 'Vakao Request Interceptor',
          version: manifest.version,
          comment: `由 Vakao 侧边栏已捕获的记录生成，不是 DevTools 的完整 HAR。${HAR_SCOPE_NOTE}`,
        },
        pages: [],
        entries,
      },
    };
  }

  function harEntry(req) {
    const url = req.finalUrl || req.url;
    const time = Math.max(0, Number(req.duration) || 0);
    const requestBody = req.requestBody || '';
    const responseBody = req.responseBody || '';

    const entry = {
      startedDateTime: harTimestamp(req.timestamp),
      time,
      request: {
        method: req.method || 'GET',
        url,
        httpVersion: 'HTTP/1.1',
        cookies: harCookies(headerValue(req.requestHeaders, 'cookie')),
        headers: harHeaders(req.requestHeaders),
        queryString: harQueryString(url),
        headersSize: -1,
        bodySize: originalSize(req.requestBodyBytes),
      },
      response: {
        status: Number(req.status) || 0,
        statusText: req.statusText || '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: harHeaders(req.responseHeaders),
        content: {
          size: originalSize(req.responseBodyBytes),
          mimeType: headerValue(req.responseHeaders, 'content-type') || 'text/plain',
          text: responseBody,
        },
        redirectURL: headerValue(req.responseHeaders, 'location'),
        headersSize: -1,
        bodySize: originalSize(req.responseBodyBytes),
      },
      cache: {},
      // send/wait/receive 之和必须等于 time，这里的耗时是整请求耗时，全部计入 wait
      timings: { blocked: -1, dns: -1, connect: -1, send: 0, wait: time, receive: 0, ssl: -1 },
      _resourceType: req.type === 'xhr' ? 'xhr' : 'fetch',
      _intercepted: Boolean(req.intercepted),
    };

    if (requestBody) {
      entry.request.postData = {
        mimeType: headerValue(req.requestHeaders, 'content-type') || 'application/x-www-form-urlencoded',
        text: requestBody,
      };
    }
    if (req.ruleName) entry._matchedRule = req.ruleName;

    const notes = [];
    if (req.requestBodyNote) notes.push(req.requestBodyNote);
    if (req.responseBodyNote) notes.push(req.responseBodyNote);
    if (notes.length) entry.comment = notes.join('；');

    return entry;
  }

  /** Cookie 头是 `a=1; b=2` 形式，拆成 HAR 的 cookies 数组；Set-Cookie 涉及过期时间等复杂语法，保持空数组 */
  function harCookies(cookieHeader) {
    if (!cookieHeader) return [];
    return cookieHeader
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf('=');
        return index < 0
          ? { name: item, value: '' }
          : { name: item.slice(0, index).trim(), value: item.slice(index + 1).trim() };
      });
  }

  function harHeaders(headers) {
    return Object.entries(headers || {}).map(([name, value]) => ({ name, value: String(value) }));
  }

  function harQueryString(url) {
    try {
      return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
    } catch (error) {
      return [];
    }
  }

  function harTimestamp(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  /** 请求头/响应头名大小写不敏感 */
  function headerValue(headers, name) {
    if (!headers) return '';
    const target = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return String(value);
    }
    return '';
  }

  function byteLength(text) {
    return text ? new TextEncoder().encode(text).length : 0;
  }

  /**
   * 体的原始字节数（截断前）。新记录由拦截器直接上报，旧记录没有这个字段，
   * 拿不到时按 HAR 规范用 -1 表示不可得，不要用截断后的长度冒充。
   */
  function originalSize(value) {
    return typeof value === 'number' && value >= 0 ? value : -1;
  }

  function harFileName() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `vakao-${stamp}.har`;
  }

  function downloadFile(filename, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  /* ===================================================================
   *  规则列表
   * =================================================================== */

  function bindRulePanel() {
    el('ruleList').addEventListener('click', async (event) => {
      const action = event.target.closest('[data-toggle],[data-edit],[data-delete]');
      if (!action) return;

      if (action.dataset.toggle) {
        const id = action.dataset.toggle;
        await storeRules(rules.map((rule) => (rule.id === id ? { ...rule, enabled: rule.enabled === false } : rule)));
        return;
      }

      const id = action.dataset.edit || action.dataset.delete;
      const rule = rules.find((item) => item.id === id);
      if (!rule) return;

      if (action.dataset.edit) {
        openRuleForm(rule);
      } else if (confirm(`确定删除规则「${rule.name}」？`)) {
        await storeRules(rules.filter((item) => item.id !== id));
      }
    });

    el('addRule').addEventListener('click', () => openRuleForm(null));
    el('saveRule').addEventListener('click', submitRuleForm);
    // 输入框里回车会触发表单隐式提交，导致侧边栏重载
    el('ruleForm').addEventListener('submit', (event) => {
      event.preventDefault();
      submitRuleForm();
    });

    el('ruleAction').addEventListener('change', syncActionSections);
    el('importRules').addEventListener('click', () => el('importFileInput').click());
    el('importFileInput').addEventListener('change', importRules);
    el('exportRules').addEventListener('click', exportRules);
  }

  function renderRules() {
    if (rules.length === 0) {
      ruleList.innerHTML = '<div class="empty-state">暂无拦截规则</div>';
      return;
    }
    ruleList.innerHTML = rules.map(ruleRow).join('');
  }

  function ruleRow(rule) {
    const actionLabel = { mock: 'Mock', modify: '修改', redirect: '重定向' }[rule.action] || rule.action;
    const methods = Array.isArray(rule.methods) && rule.methods.length ? `<span class="rule-tag">${esc(rule.methods.join('/'))}</span>` : '';
    return `<div class="rule-item${rule.enabled === false ? ' disabled' : ''}" data-id="${esc(rule.id)}">
      <div class="rule-item-header">
        <span class="rule-name">${esc(rule.name)}</span>
        <div class="rule-actions">
          <div class="toggle-switch${rule.enabled === false ? '' : ' active'}" data-toggle="${esc(rule.id)}" title="启用 / 停用"></div>
          <button class="btn btn-secondary" data-edit="${esc(rule.id)}">编辑</button>
          <button class="btn btn-secondary" data-delete="${esc(rule.id)}">删除</button>
        </div>
      </div>
      <div class="rule-info">
        <span class="rule-tag">${rule.matchType === 'regex' ? '正则' : '包含'}</span>
        <span class="rule-tag">${esc(rule.urlPattern)}</span>
        <span class="rule-tag">${actionLabel}</span>
        ${methods}
      </div>
    </div>`;
  }

  /* ===================================================================
   *  规则表单
   * =================================================================== */

  function openRuleForm(rule) {
    el('ruleModalTitle').textContent = rule ? '编辑规则' : '添加规则';
    el('ruleForm').reset();
    el('ruleId').value = rule ? rule.id : '';

    if (rule) {
      el('ruleName').value = rule.name;
      el('ruleUrlPattern').value = rule.urlPattern;
      el('ruleMatchType').value = rule.matchType;
      el('ruleAction').value = rule.action;
      document.querySelectorAll('input[name="method"]').forEach((input) => {
        input.checked = rule.methods.includes(input.value);
      });

      if (rule.action === 'mock') {
        el('mockStatus').value = rule.mockStatus || 200;
        el('mockBody').value = rule.mockBody || '';
        el('mockHeaders').value = rule.mockHeaders ? JSON.stringify(rule.mockHeaders, null, 2) : '';
      } else if (rule.action === 'modify') {
        el('modifyQuery').value = rule.modifyQuery ? JSON.stringify(rule.modifyQuery, null, 2) : '';
        el('modifyBody').value = rule.modifyBody || '';
        el('customHeaders').value = rule.customHeaders ? JSON.stringify(rule.customHeaders, null, 2) : '';
      } else {
        el('redirectUrl').value = rule.redirectUrl || '';
      }
    } else {
      el('ruleAction').value = 'mock';
      el('mockStatus').value = 200;
    }

    syncActionSections();
    el('ruleModal').classList.remove('hidden');
    el('ruleName').focus();
  }

  function syncActionSections() {
    const action = el('ruleAction').value;
    el('mockSection').classList.toggle('hidden', action !== 'mock');
    el('modifySection').classList.toggle('hidden', action !== 'modify');
    el('redirectSection').classList.toggle('hidden', action !== 'redirect');
  }

  async function submitRuleForm() {
    const name = el('ruleName').value.trim();
    const urlPattern = el('ruleUrlPattern').value.trim();
    if (!name || !urlPattern) return toast('规则名称和 URL 匹配模式不能为空', true);

    const matchType = el('ruleMatchType').value;
    if (matchType === 'regex') {
      try {
        new RegExp(urlPattern);
      } catch (error) {
        return toast(`正则表达式无效：${error.message}`, true);
      }
    }

    const action = el('ruleAction').value;
    const next = {
      name,
      urlPattern,
      matchType,
      methods: [...document.querySelectorAll('input[name="method"]:checked')].map((input) => input.value),
      action,
      enabled: true,
    };

    try {
      if (action === 'mock') {
        next.mockStatus = Number(el('mockStatus').value) || 200;
        next.mockBody = el('mockBody').value;
        next.mockHeaders = parseJsonObject(el('mockHeaders').value, { 'Content-Type': 'application/json' }, '响应头');
      } else if (action === 'modify') {
        next.modifyQuery = parseJsonObject(el('modifyQuery').value, {}, 'Query 参数');
        next.modifyBody = el('modifyBody').value;
        next.customHeaders = parseJsonObject(el('customHeaders').value, {}, '请求头');
      } else {
        const redirectUrl = el('redirectUrl').value.trim();
        if (!redirectUrl) return toast('请填写重定向 URL', true);
        next.redirectUrl = redirectUrl;
      }
    } catch (error) {
      return toast(error.message, true);
    }

    const editingId = el('ruleId').value;
    const existing = editingId ? rules.find((rule) => rule.id === editingId) : null;
    if (existing) {
      next.id = existing.id;
      next.enabled = existing.enabled !== false;
      await storeRules(rules.map((rule) => (rule.id === next.id ? next : rule)));
    } else {
      next.id = uid();
      await storeRules(rules.concat(next));
    }

    el('ruleModal').classList.add('hidden');
    toast(existing ? '规则已更新' : '规则已添加');
  }

  /** JSON 输入框统一校验：非法 JSON 直接报错，不再静默替换成默认值 */
  function parseJsonObject(text, fallback, label) {
    const trimmed = text.trim();
    if (!trimmed) return fallback;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${label}不是合法 JSON：${error.message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label}必须是 JSON 对象`);
    }
    return parsed;
  }

  /* ===================================================================
   *  导入 / 导出
   * =================================================================== */

  async function importRules(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;

    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error('文件内容必须是规则数组');

      const imported = data
        .filter((item) => item && typeof item === 'object' && typeof item.urlPattern === 'string' && item.urlPattern !== '')
        .map(normalizeRule);
      if (imported.length === 0) throw new Error('没有可用的规则');

      if (!confirm(`将覆盖当前 ${rules.length} 条规则，导入 ${imported.length} 条规则？`)) return;
      await storeRules(imported);
      toast(`已导入 ${imported.length} 条规则`);
    } catch (error) {
      toast(`导入失败：${error.message}`, true);
    }
  }

  function exportRules() {
    downloadFile(
      `vakao-rules-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(rules, null, 2),
      'application/json',
    );
  }

  function normalizeRules(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((item) => item && typeof item === 'object').map(normalizeRule);
  }

  function normalizeRule(raw) {
    return {
      ...raw,
      id: typeof raw.id === 'string' && raw.id ? raw.id : uid(),
      name: String(raw.name || raw.urlPattern || '未命名规则'),
      urlPattern: String(raw.urlPattern || ''),
      matchType: raw.matchType === 'regex' ? 'regex' : 'contains',
      methods: Array.isArray(raw.methods) ? raw.methods.map(String) : [],
      action: ['mock', 'modify', 'redirect'].includes(raw.action) ? raw.action : 'mock',
      enabled: raw.enabled !== false,
    };
  }

  /* ===================================================================
   *  从请求快速创建规则
   * =================================================================== */

  function createRuleFromRequest(action) {
    const req = detailRequest;
    if (!req) return;

    el('requestDetail').classList.add('hidden');
    openRuleForm(null);

    // 用 pathname 作为匹配模式：同一接口在不同环境（域名/端口）下都能命中
    let pattern = req.url;
    try {
      const parsed = new URL(req.url);
      pattern = parsed.pathname === '/' ? parsed.hostname : parsed.pathname;
    } catch (error) {
      // 非法 URL 就退回完整地址
    }

    el('ruleName').value = `${action === 'mock' ? 'Mock' : '修改'} ${pattern}`;
    el('ruleUrlPattern').value = pattern;
    el('ruleMatchType').value = 'contains';
    document.querySelectorAll('input[name="method"]').forEach((input) => {
      input.checked = input.value === req.method;
    });
    el('ruleAction').value = action;

    if (action === 'mock') {
      el('mockStatus').value = req.status || 200;
      el('mockBody').value = prettyJson(req.responseBody || '');
      el('mockHeaders').value = JSON.stringify(req.responseHeaders || {}, null, 2);
    } else {
      el('customHeaders').value = JSON.stringify(req.requestHeaders || {}, null, 2);
      el('modifyBody').value = req.requestBody || '';
      el('modifyQuery').value = '{}';
    }

    syncActionSections();
  }

  /* ===================================================================
   *  工具函数
   * =================================================================== */

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function statusClass(status) {
    const code = Number(status);
    if (code >= 200 && code < 300) return 'status-2xx';
    if (code >= 300 && code < 400) return 'status-3xx';
    if (code >= 400 && code < 500) return 'status-4xx';
    if (code >= 500) return 'status-5xx';
    return '';
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname + parsed.search;
      return path.length > 50 ? `${parsed.hostname}${path.slice(0, 50)}…` : `${parsed.hostname}${path}`;
    } catch (error) {
      return url.length > 60 ? `${url.slice(0, 60)}…` : url;
    }
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleTimeString('zh-CN', { hour12: false });
  }

  function toast(message, isError) {
    let node = document.getElementById('toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'toast';
      document.body.appendChild(node);
    }
    node.className = `toast${isError ? ' error' : ''}`;
    node.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      node.className = 'toast hide';
    }, 2200);
  }
})();
