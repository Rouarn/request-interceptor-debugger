/**
 * content/interceptor.js
 *
 * 主世界拦截器：Monkey Patch window.fetch 与 XMLHttpRequest，实现
 * 记录 / Mock / 修改 / 重定向 四类能力。
 *
 * 该脚本由 manifest 以 world: "MAIN" 注入，因此：
 *   - 在页面脚本之前执行（document_start），能拦到页面的第一个请求
 *   - 不受页面 CSP 限制，也不暴露 web_accessible_resources
 *   - 没有 chrome.* API，只能通过 postMessage 与隔离世界的 content-script 通信
 *
 * 设计原则：
 *   - 没有命中规则时，原样透传原始参数，绝不重建 Request/选项。重建会丢 signal、
 *     凭证模式，还会把 Request 的 body 流读走，直接改变页面行为。
 *   - 读取响应体不阻塞响应返回，并跳过二进制/SSE（SSE 的 clone().text() 永远
 *     不会 resolve，会持续吃内存）。
 */
(function () {
  'use strict';

  // 同一个页面可能被重复注入（例如 bfcache 恢复），只允许打一次补丁
  if (window.__vakaoInterceptor) return;
  window.__vakaoInterceptor = true;

  const CHANNEL = 'vakao-interceptor';

  /** 响应体最多读取的字节数，超出即截断并取消流 */
  const MAX_BODY_BYTES = 128 * 1024;
  /** 上报前对文本字段的长度上限，避免超大 body 撑爆消息通道 */
  const MAX_TEXT_CHARS = 128 * 1024;

  /** 这些类型不值得读 body：二进制没意义，SSE 则可能永远读不完 */
  const SKIP_BODY_TYPE =
    /^(?:image|video|audio|font)\/|^text\/event-stream|^application\/(?:octet-stream|pdf|zip|x-zip-compressed|wasm|protobuf|x-protobuf)/i;

  const nativeFetch = window.fetch;
  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const nativeXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  /** 挂在 XHR 实例上的状态字段名 */
  const XHR_STATE = '__vakaoState';

  /** @type {Array<Object>} 已编译的规则（正则预编译，避免每个请求都 new RegExp） */
  let rules = [];

  /* ===================================================================
   *  与 content script 的桥接
   * =================================================================== */

  function post(payload) {
    window.postMessage({ channel: CHANNEL, source: 'main', ...payload }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.source !== 'content') return;
    if (data.type === 'RULES') rules = compileRules(data.rules);
  });

  // 通知 content script 当前规则；它也会主动推一次，两个方向任意一个先到都行
  post({ type: 'READY' });

  /* ===================================================================
   *  规则匹配
   * =================================================================== */

  /**
   * 校验并预处理规则。
   *
   * 空 urlPattern 的规则会被丢弃：`url.includes('')` 恒为 true，一条空规则就能
   * Mock 掉整个页面所有请求（导入的规则文件里很容易出现这种情况）。
   */
  function compileRules(input) {
    if (!Array.isArray(input)) return [];
    const compiled = [];
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.enabled === false) continue;
      if (typeof raw.urlPattern !== 'string' || raw.urlPattern === '') continue;

      const action = raw.action === 'modify' || raw.action === 'redirect' ? raw.action : 'mock';
      if (action === 'redirect' && typeof raw.redirectUrl !== 'string') continue;

      const rule = {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : '',
        matchType: raw.matchType === 'regex' ? 'regex' : 'contains',
        urlPattern: raw.urlPattern,
        methods: Array.isArray(raw.methods) ? raw.methods.map((m) => String(m).toUpperCase()) : [],
        action,
        mockStatus: raw.mockStatus,
        mockStatusText: raw.mockStatusText,
        mockHeaders: raw.mockHeaders,
        mockBody: raw.mockBody,
        modifyQuery: raw.modifyQuery,
        modifyBody: raw.modifyBody,
        customHeaders: raw.customHeaders,
        redirectUrl: raw.redirectUrl,
      };

      if (rule.matchType === 'regex') {
        try {
          rule.regex = new RegExp(rule.urlPattern);
        } catch (error) {
          // 语法错误的正则规则直接跳过，不要让一条坏规则让所有请求报错
          continue;
        }
      }
      compiled.push(rule);
    }
    return compiled;
  }

  function matchRule(url, method) {
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.methods.length > 0 && !rule.methods.includes(method)) continue;
      const matched = rule.regex ? rule.regex.test(url) : url.includes(rule.urlPattern);
      if (matched) return rule;
    }
    return null;
  }

  /* ===================================================================
   *  上报
   * =================================================================== */

  /**
   * 统一的请求上报出口。
   * base 只携带身份信息（url/method/type/规则），extra 携带本次耗时与响应数据。
   */
  function report(base, extra) {
    post({
      type: 'CAPTURED',
      request: {
        url: base.url,
        method: base.method,
        type: base.type,
        timestamp: base.timestamp,
        intercepted: Boolean(base.rule),
        ruleId: base.rule ? base.rule.id : null,
        ruleName: base.rule ? base.rule.name : '',
        action: base.rule ? base.rule.action : null,
        requestHeaders: base.requestHeaders || {},
        requestBody: base.requestBody || '',
        ...extra,
      },
    });
  }

  function reportFailure(base, started, error) {
    report(base, {
      finalUrl: base.url,
      status: 0,
      statusText: 'Network Error',
      responseHeaders: {},
      responseBody: clipText(String((error && error.message) || error || '请求失败')),
      duration: Math.round(performance.now() - started),
    });
  }

  /* ===================================================================
   *  fetch
   * =================================================================== */

  window.fetch = function (input, init) {
    const started = performance.now();
    const isRequest = input instanceof Request;
    // 页面大量使用 fetch('/api/...')，必须先解析成绝对地址才能参与规则匹配
    const url = isRequest ? input.url : absoluteUrl(input);
    const method = String((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase();

    // data: / blob: 之类没有拦截和展示价值，原样放行
    if (!url || !isHttpUrl(url)) return nativeFetch.apply(this, arguments);

    // fetch(undefined) 这类非法调用交给原生实现抛错，不要被拼成 "http://host/undefined"
    if (!isRequest && (input === undefined || input === null)) return nativeFetch.apply(this, arguments);

    const base = {
      url,
      method,
      type: 'fetch',
      timestamp: new Date().toISOString(),
      requestHeaders: isRequest ? headersToObject(input.headers) : headersToObject(init && init.headers),
      requestBody: describeBody(isRequest ? input.body : init && init.body),
      rule: matchRule(url, method),
    };

    if (!base.rule) return passthroughFetch(this, arguments, base, started);

    if (base.rule.action === 'mock') {
      return Promise.resolve(mockFetch(base));
    }

    return sendFetchWithRule(this, input, init, isRequest, base, started);
  };

  /**
   * 拒绝重建请求：直接把原始参数交给原生 fetch。
   * 响应克隆只是为了展示，读取失败不影响页面。
   */
  function passthroughFetch(self, args, base, started) {
    let pending;
    try {
      pending = nativeFetch.apply(self, args);
    } catch (error) {
      reportFailure(base, started, error);
      throw error;
    }
    return pending.then(
      (response) => {
        captureResponse(response, base, started);
        return response;
      },
      (error) => {
        reportFailure(base, started, error);
        throw error;
      },
    );
  }

  function mockFetch(base) {
    const mock = mockPayload(base.rule);
    report(base, {
      finalUrl: base.url,
      status: mock.status,
      statusText: mock.statusText,
      responseHeaders: mock.headers,
      responseBody: clipText(mock.body),
      duration: 0,
    });
    try {
      return new Response(mock.body, {
        status: mock.status,
        statusText: mock.statusText,
        headers: mock.headers,
      });
    } catch (error) {
      // 手写的 statusText / headers 可能不符合规范，退化成最保守的响应
      return new Response(mock.body, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  /**
   * 应用 redirect / modify 规则后再发请求。
   *
   * 用 Request 逐层"套娃"构造：new Request(url, req) / new Request(req, {headers})，
   * 这样能原样保留 method、credentials、signal 和 body 流，不用手工逐字段搬运。
   */
  function sendFetchWithRule(self, input, init, isRequest, base, started) {
    const rule = base.rule;
    let request = null;
    let bodyText = base.requestBody;

    try {
      request = isRequest ? new Request(input, init) : new Request(base.url, init);

      if (rule.action === 'redirect' && rule.redirectUrl) {
        const target = absoluteUrl(rule.redirectUrl);
        if (target) request = new Request(target, request);
      }

      if (rule.action === 'modify') {
        if (rule.modifyQuery) {
          request = new Request(applyQuery(request.url, rule.modifyQuery), request);
        }
        const merged = mergeHeaders(request.headers, rule.customHeaders);
        if (merged) request = new Request(request, { headers: merged });
        if (typeof rule.modifyBody === 'string' && rule.modifyBody !== '' && !hasNoBody(request.method)) {
          request = new Request(request, { body: rule.modifyBody });
          bodyText = rule.modifyBody;
        }
      }
    } catch (error) {
      // 例如 body 已被页面消费、流式请求无法复制：退回原始调用，保证页面不被打断
      request = null;
    }

    if (!request) {
      return passthroughFetch(self, isRequest ? [input, init] : [base.url, init], base, started);
    }

    const dispatched = {
      ...base,
      requestHeaders: headersToObject(request.headers),
      requestBody: bodyText,
    };

    return nativeFetch.call(self, request).then(
      (response) => {
        captureResponse(response, dispatched, started);
        return response;
      },
      (error) => {
        reportFailure(dispatched, started, error);
        throw error;
      },
    );
  }

  /** 读取响应体并上报；不 await，响应立刻返还给页面 */
  function captureResponse(response, base, started) {
    const snapshot = {
      finalUrl: response.url || base.url,
      status: response.status,
      statusText: response.statusText,
      responseHeaders: headersToObject(response.headers),
      duration: Math.round(performance.now() - started),
    };
    readResponseBody(response)
      .then((body) => report(base, { ...snapshot, responseBody: clipText(body) }))
      .catch(() => report(base, { ...snapshot, responseBody: '' }));
  }

  /**
   * 限量读取响应体副本。
   *
   * 不用 response.clone().text()：大响应会把整份内容驻留内存，SSE 更是永远读不完。
   * 这里按字节限量读、超限主动 cancel，并把二进制类型整体跳过。
   */
  async function readResponseBody(response) {
    if (response.status === 204 || response.status === 304) return '';
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (SKIP_BODY_TYPE.test(contentType)) return `[已跳过 ${contentType} 响应体]`;

    let clone;
    try {
      clone = response.clone();
    } catch (error) {
      return '[响应体已被页面读取]';
    }
    if (!clone.body) return '';

    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    try {
      while (bytes < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) return text + decoder.decode();
        bytes += value.byteLength;
        text += decoder.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
      return text + decoder.decode() + '\n…（响应体超过 128KB，已截断）';
    } catch (error) {
      return text;
    }
  }

  /* ===================================================================
   *  XMLHttpRequest
   * =================================================================== */

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    resetXhrState(this);

    const absolute = absoluteUrl(url);
    if (!absolute || !isHttpUrl(absolute)) {
      return nativeXhrOpen.apply(this, [method, url, ...rest]);
    }

    const upperMethod = String(method).toUpperCase();
    const rule = matchRule(absolute, upperMethod);
    let target = absolute;

    if (rule) {
      if (rule.action === 'redirect' && rule.redirectUrl) {
        target = absoluteUrl(rule.redirectUrl) || absolute;
      } else if (rule.action === 'modify' && rule.modifyQuery) {
        target = applyQuery(absolute, rule.modifyQuery);
      }
    }

    this[XHR_STATE] = {
      url: absolute,
      finalUrl: target,
      method: upperMethod,
      type: 'xhr',
      headers: {},
      requestBody: '',
      rule,
    };

    return nativeXhrOpen.call(this, method, target, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const state = this[XHR_STATE];
    if (state) {
      const rule = state.rule;
      if (rule && rule.action === 'modify') {
        const override = findHeader(rule.customHeaders, name);
        if (override !== undefined) value = String(override);
      }
      state.headers[name] = value;
    }
    return nativeXhrSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const state = this[XHR_STATE];
    if (!state) return nativeXhrSend.call(this, body);

    const started = performance.now();
    state.timestamp = new Date().toISOString();
    state.requestBody = describeBody(body);
    const rule = state.rule;

    if (rule && rule.action === 'mock') {
      applyMockXhr(this, state, body, started);
      return;
    }

    if (rule && rule.action === 'modify') {
      if (typeof rule.modifyBody === 'string' && rule.modifyBody !== '' && !hasNoBody(state.method)) {
        body = rule.modifyBody;
        state.requestBody = rule.modifyBody;
      }
      // 补齐规则里声明、但页面没有设置过的请求头
      for (const [name, value] of Object.entries(rule.customHeaders || {})) {
        if (findHeader(state.headers, name) !== undefined) continue;
        try {
          nativeXhrSetRequestHeader.call(this, name, String(value));
          state.headers[name] = String(value);
        } catch (error) {
          // 请求头阶段已结束时会抛错，忽略即可
        }
      }
    }

    this.addEventListener(
      'loadend',
      () => reportXhr(this, state, performance.now() - started),
      { once: true },
    );

    return nativeXhrSend.call(this, body);
  };

  function reportXhr(xhr, state, elapsed) {
    let body = '';
    try {
      if (xhr.responseType === '' || xhr.responseType === 'text') {
        body = xhr.responseText || '';
      } else if (xhr.responseType === 'json') {
        body = xhr.response == null ? '' : JSON.stringify(xhr.response);
      } else {
        body = `[responseType: ${xhr.responseType}]`;
      }
    } catch (error) {
      body = '';
    }

    report(state, {
      finalUrl: xhr.responseURL || state.finalUrl,
      status: xhr.status,
      statusText: xhr.statusText || (xhr.status === 0 ? '请求失败或被取消' : ''),
      responseHeaders: parseRawHeaders(rawResponseHeaders(xhr)),
      responseBody: clipText(body),
      duration: Math.round(elapsed),
    });
  }

  /**
   * 伪造成已完成的 XHR。
   *
   * 只 dispatchEvent，不再手动调用 onload/onreadystatechange——handler 本身就会
   * 被 dispatchEvent 触发，手动再调一次会让页面的回调执行两遍。
   * 同时支持 responseType 为 json/blob/arraybuffer，避免页面拿到字符串崩溃。
   */
  function applyMockXhr(xhr, state, rawBody, started) {
    const mock = mockPayload(state.rule);
    const responseType = xhr.responseType;
    let responseValue = mock.body;

    if (responseType === 'json') {
      try {
        responseValue = JSON.parse(mock.body);
      } catch (error) {
        responseValue = null;
      }
    } else if (responseType === 'blob') {
      responseValue = new Blob([mock.body], { type: contentTypeOf(mock.headers) });
    } else if (responseType === 'arraybuffer') {
      responseValue = new TextEncoder().encode(mock.body).buffer;
    }

    try {
      Object.defineProperties(xhr, {
        readyState: { configurable: true, get: () => 4 },
        status: { configurable: true, get: () => mock.status },
        statusText: { configurable: true, get: () => mock.statusText },
        responseURL: { configurable: true, get: () => state.finalUrl },
        responseText: {
          configurable: true,
          get: () => (responseType === '' || responseType === 'text' ? mock.body : ''),
        },
        response: {
          configurable: true,
          get: () => (responseType === '' || responseType === 'text' ? mock.body : responseValue),
        },
        getAllResponseHeaders: {
          configurable: true,
          value: () => formatHeaders(mock.headers),
        },
        getResponseHeader: {
          configurable: true,
          value: (name) => {
            const value = findHeader(mock.headers, name);
            return value === undefined ? null : String(value);
          },
        },
      });
    } catch (error) {
      // 极端情况下实例不可改写：退回真实请求，而不是让页面永远等不到回调
      nativeXhrSend.call(xhr, rawBody);
      return;
    }

    report(state, {
      finalUrl: state.finalUrl,
      status: mock.status,
      statusText: mock.statusText,
      responseHeaders: mock.headers,
      responseBody: clipText(mock.body),
      duration: Math.round(performance.now() - started),
    });

    setTimeout(() => {
      try {
        xhr.dispatchEvent(new Event('readystatechange'));
        xhr.dispatchEvent(new Event('load'));
        xhr.dispatchEvent(new Event('loadend'));
      } catch (error) {
        // 页面已经移除了监听器，忽略
      }
    }, 0);
  }

  /** 清理上一轮 mock 留在实例上的自有属性，避免复用的 XHR 被永久冻结 */
  function resetXhrState(xhr) {
    for (const key of [
      'readyState',
      'status',
      'statusText',
      'responseURL',
      'responseText',
      'response',
      'getAllResponseHeaders',
      'getResponseHeader',
    ]) {
      try {
        delete xhr[key];
      } catch (error) {
        // 非自有属性删除失败无妨
      }
    }
    delete xhr[XHR_STATE];
  }

  function rawResponseHeaders(xhr) {
    try {
      return xhr.getAllResponseHeaders();
    } catch (error) {
      return '';
    }
  }

  function parseRawHeaders(raw) {
    const headers = {};
    if (!raw) return headers;
    for (const line of raw.trim().split(/[\r\n]+/)) {
      const index = line.indexOf(':');
      if (index > 0) headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return headers;
  }

  function formatHeaders(headers) {
    return Object.entries(headers || {})
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('');
  }

  /* ===================================================================
   *  公共工具
   * =================================================================== */

  function mockPayload(rule) {
    let status = Number(rule.mockStatus);
    if (!Number.isInteger(status) || status < 200 || status > 599) status = 200;

    // 规则里的响应头来自用户手写 JSON，可能带非法字段名或非字符串值。
    // 过一遍 Headers 校验并转成纯对象，既能安全传给 Response，也能安全 postMessage。
    let headers = { 'Content-Type': 'application/json' };
    if (rule.mockHeaders && typeof rule.mockHeaders === 'object' && !Array.isArray(rule.mockHeaders)) {
      try {
        const normalized = new Headers();
        for (const [name, value] of Object.entries(rule.mockHeaders)) {
          if (value === null || value === undefined) continue;
          normalized.set(name, String(value));
        }
        headers = Object.fromEntries(normalized.entries());
        if (!normalized.has('content-type')) headers['content-type'] = 'application/json';
      } catch (error) {
        headers = { 'Content-Type': 'application/json' };
      }
    }

    return {
      status,
      statusText: typeof rule.mockStatusText === 'string' ? rule.mockStatusText : '',
      headers,
      body: typeof rule.mockBody === 'string' && rule.mockBody !== '' ? rule.mockBody : '{}',
    };
  }

  function mergeHeaders(original, custom) {
    if (!custom || typeof custom !== 'object') return null;
    const entries = Object.entries(custom);
    if (entries.length === 0) return null;

    const headers = new Headers();
    try {
      original.forEach((value, name) => headers.set(name, value));
    } catch (error) {
      // 原始 headers 不可读时以自定义头为准
    }
    for (const [name, value] of entries) headers.set(name, String(value));
    return headers;
  }

  function headersToObject(headers) {
    const result = {};
    if (!headers) return result;
    try {
      if (typeof headers.forEach === 'function') {
        headers.forEach((value, name) => {
          result[name] = value;
        });
      } else if (Array.isArray(headers)) {
        for (const [name, value] of headers) result[name] = value;
      } else {
        Object.assign(result, headers);
      }
    } catch (error) {
      // 非标准 headers 结构，返回空对象
    }
    return result;
  }

  function describeBody(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return clipText(body);
    if (body instanceof URLSearchParams) return clipText(body.toString());
    if (body instanceof FormData) {
      const pairs = [];
      for (const [name, value] of body) {
        pairs.push(`${name}=${typeof value === 'string' ? value : `[File ${value.name} ${value.size}B]`}`);
      }
      return clipText(pairs.join('&'));
    }
    if (body instanceof Blob) return `[Blob ${body.type || 'binary'} ${body.size}B]`;
    if (body instanceof ArrayBuffer) return `[ArrayBuffer ${body.byteLength}B]`;
    if (ArrayBuffer.isView(body)) return `[${body.constructor.name} ${body.byteLength}B]`;
    if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '[ReadableStream]';
    return clipText(String(body));
  }

  function clipText(text) {
    if (typeof text !== 'string') return text == null ? '' : String(text);
    if (text.length <= MAX_TEXT_CHARS) return text;
    return text.slice(0, MAX_TEXT_CHARS) + '\n…（内容过长，已截断）';
  }

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(url);
  }

  /**
   * 解析成绝对 URL。
   * 基准取 document.baseURI 而不是 location.href：页面有 <base href> 时两者的
   * 解析结果不同，XHR 的规范行为是跟随 base URL。
   */
  function absoluteUrl(url) {
    try {
      return new URL(String(url), document.baseURI).href;
    } catch (error) {
      return null;
    }
  }

  function applyQuery(url, query) {
    try {
      const parsed = new URL(url);
      for (const [name, value] of Object.entries(query || {})) {
        parsed.searchParams.set(name, String(value));
      }
      return parsed.href;
    } catch (error) {
      return url;
    }
  }

  /** 请求头名不区分大小写，统一走这个查找，避免 "Authorization" / "authorization" 互不识别 */
  function findHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return undefined;
    const target = String(name).toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return value;
    }
    return undefined;
  }

  function contentTypeOf(headers) {
    return String(findHeader(headers, 'content-type') || 'application/json');
  }

  function hasNoBody(method) {
    return method === 'GET' || method === 'HEAD';
  }
})();
