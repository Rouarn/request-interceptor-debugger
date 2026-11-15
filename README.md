# Vakao - 网页请求拦截与调试工具

一个零侵入的 Chrome 扩展，用于拦截、修改和 Mock 网络请求。基于 Manifest V3，通过 Monkey Patch 透明接管页面的 `fetch` 和 `XMLHttpRequest`。

## 功能特性

- **请求捕获**：捕获页面 fetch / XHR 请求，展示方法、URL、状态码、耗时
- **请求过滤**：按 URL 关键字、HTTP 方法、状态码范围过滤
- **Mock 响应**：返回自定义状态码、响应头、响应体，不发出真实请求
- **修改请求**：修改查询参数、请求头、请求体
- **请求重定向**：把匹配请求的地址改写为指定 URL
- **规则管理**：创建、编辑、删除、启用/停用，支持 JSON 导入导出
- **一键复制**：复制为 cURL 命令或复制响应体
- **从请求创建规则**：基于已捕获请求快速生成 Mock / 修改规则

## 项目结构

```
request-interceptor-debugger/
├── manifest.json              # MV3 配置：主世界与隔离世界各注入一个脚本
├── background/
│   └── service-worker.js      # 只做消息转发与徽标，不保存业务状态
├── content/
│   ├── content-script.js      # 隔离世界桥接：规则下发 + 请求批量上报
│   └── interceptor.js         # 主世界拦截器：Patch fetch / XMLHttpRequest
├── sidepanel/
│   ├── sidepanel.html         # 侧边栏结构
│   ├── sidepanel.css          # 侧边栏样式（CSS 变量主题）
│   └── sidepanel.js           # 侧边栏逻辑（原生 JS，无框架）
└── icons/                     # 图标
```

## 架构说明

```
主世界 interceptor.js ──postMessage──> 隔离世界 content-script.js ──攒批──> Service Worker
        ▲                                                                       │
        └──────────────── postMessage（规则）<── chrome.storage.onChanged        │ 仅在侧边栏存在时转发
                                                                                ▼
                                                                           Side Panel
```

### 关键设计

- **主世界注入**：`interceptor.js` 由 manifest 以 `world: "MAIN"` + `document_start` 注入。
  不通过 `<script src>` 注入，因此不受页面 CSP（`script-src`）限制，也不需要
  `web_accessible_resources`。
- **规则唯一来源**：规则只存在 `chrome.storage.local`。侧边栏直接读写，content script
  监听 `chrome.storage.onChanged` 后下发，Service Worker 不参与规则管理。
  Service Worker 被浏览器回收（空闲约 30 秒）不会丢失任何规则。
- **日志归属**：请求日志只保存在侧边栏内存中，面板关闭即停止记录。这是刻意取舍：
  日志只在"打开面板调试"时有意义，放进存储会让每个请求都产生写入开销，且
  Service Worker 回收后依然会丢。
- **批量上报**：content script 每 200ms 或每 50 条合并上报一次，Service Worker 用
  `chrome.runtime.getContexts()` 判断侧边栏是否存在，不存在就直接丢弃，不做无效广播。
- **抓包开销**：读取响应体不阻塞响应返回；跳过二进制、SSE 类型；单条最多读 128KB。
- **无命中即透传**：请求没有命中规则时，直接调用原始 fetch，不重建 Request，避免
  丢失 `signal`、凭证模式或读走 body 流。

### 规则匹配

- **包含匹配（contains）**：URL 包含指定字符串
- **正则匹配（regex）**：正则表达式匹配 URL
- 可限制生效的 HTTP 方法（GET/POST/PUT/DELETE/PATCH），多选生效
- 规则按列表顺序匹配，第一条命中的规则生效
- 空 `urlPattern` 的规则会被忽略（否则会匹配所有请求）

### 拦截动作

| 动作 | 说明 |
|------|------|
| **Mock** | 返回自定义响应，不发送真实请求 |
| **Modify** | 修改请求头、请求体、查询参数后发送真实请求 |
| **Redirect** | 把请求地址改写为指定 URL 后发送 |

Redirect 直接改写 URL，由页面按正常同源 / CORS 规则发出，因此会保留 Cookie 与登录态；
如果目标域名不允许跨域，请求会和普通跨域请求一样被浏览器拦截。

## 安装使用

1. 打开 `chrome://extensions/`，开启右上角「开发者模式」
2. 点击「加载已解压的扩展程序」，选择本项目根目录
3. 点击工具栏图标打开侧边栏
4. 在「请求列表」查看捕获的请求，点击查看详情（概览 / 请求头 / 请求体 / 响应）
5. 在「拦截规则」创建规则，或在详情里用「Mock 此请求」「修改此请求」快速生成

## 权限说明

| 权限 | 用途 |
|------|------|
| `storage` | 保存拦截规则 |
| `sidePanel` | 提供侧边栏界面 |
| `<all_urls>` | 在任意站点注入内容脚本，这是请求调试工具的必要条件 |

不使用 `scripting`、`activeTab`、`web_accessible_resources`，扩展没有对外暴露任何可被网页加载的资源。

## 浏览器兼容性

- Google Chrome 116+（依赖 `chrome.runtime.getContexts`）
- Chromium 内核浏览器（Edge、Brave 等）

## 开发

纯静态文件，无构建步骤。修改后在 `chrome://extensions/` 点击刷新按钮即可生效。

## License

MIT
