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
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'REQUESTS') ingest(message.list);
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
  }

  function renderRequests() {
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
      renderPayload(container, req.requestBody, 'body');
      return;
    }
    if (detailTab === 'response') {
      renderPayload(container, req.responseBody, 'response');
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
    container.innerHTML = meta.join('');
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
   */
  function renderPayload(container, text, modeKey) {
    const emptyText = modeKey === 'body' ? '无请求体' : '无响应体';
    if (!text) {
      container.innerHTML = `<div class="empty-state">${emptyText}</div>`;
      return;
    }

    const mode = modeKey === 'body' ? bodyMode : responseMode;
    let html = `<div class="body-toggle">
      <button class="body-toggle-btn${mode === 'parsed' ? ' active' : ''}" data-view="parsed">解析</button>
      <button class="body-toggle-btn${mode === 'raw' ? ' active' : ''}" data-view="raw">原始</button>
    </div>`;

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
        renderPayload(container, text, modeKey);
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
    const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vakao-rules-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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

  let toastTimer = null;

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
