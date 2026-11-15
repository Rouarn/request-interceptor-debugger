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
- **单条重放**：在记录所属标签页里重发一次，自动继承登录态，并与原记录比状态码 / 耗时 / 响应体
- **导出 HAR**：把当前筛选结果或单条请求导出为标准 HAR 1.2 文件
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
- **抓包开销**：读取响应体不阻塞响应返回；跳过二进制、SSE 类型；上报的文本最多 128KB，超出部分只累加字节数（供 HAR 的 `size` 使用），不再驻留内存。
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

## 单条重放

请求详情底部的「重放」会把这次请求重新发一次，发在**记录所属标签页的页面上下文**里（`credentials: 'include'`），Cookie / User-Agent / Sec-Fetch-* 由浏览器自己补，因此不需要额外权限，也不会丢登录态。重放用的是拦截器保存的原生 `fetch`，不经过拦截逻辑，所以不会产生新记录、列表条数不变。

`POST` / `PUT` / `PATCH` / `DELETE` 这类非幂等请求会真实写到服务端，点击后会先弹一次确认框，写清请求方法、完整 URL，以及「可能产生副作用」；`GET` / `HEAD` 只读，直接重放，不额外打断。取消确认则什么都不发。

结果挂在原记录详情的「重放结果」里，并排显示状态码、耗时、响应体字节数和内容结论（相同 / 不同 / 无法比较）。两侧响应体只要有一侧不完整（截断、二进制、流式未采集），就只给「无法比较」并说明原因。

无法重放时会明确提示原因，不会静默失败：

- 记录里没有来源标签页信息（升级前捕获的旧记录）
- 来源标签页已关闭
- 当前标签页地址与记录请求不同源（换了域名/端口/协议，继承不到登录态）
- 当前标签页没有注入脚本（`chrome://` 等受限页面）
- 原请求体没有被完整采集（二进制、数据流或超长截断），无法忠实重放

## HAR 导出

请求列表工具条上的「导出 HAR」会导出**当前筛选结果**（未筛选即全部），详情弹窗里的「导出 HAR」导出单条。产物是标准 HAR 1.2，可直接导入 Postman / Charles / 浏览器 DevTools 的 Network 面板。

数据源就是侧边栏已捕获的记录，导出不额外采集、不需要新权限。文件里会如实标注采集边界：

- `log.creator.comment` 说明只覆盖页面 JS 发起的 fetch/XHR，不含图片、脚本、字体等资源请求，且不是 DevTools 的完整 HAR
- 每条 entry 的 `comment` 记录该条请求体/响应体被截断或未采集的原因（超长、二进制、流式、已被页面读取）

已知取舍：

- 请求头只包含页面 JS 显式设置的字段，浏览器自动附加的 `Cookie` / `User-Agent` / `Accept` / `Sec-Fetch-*` 无法从 `fetch` / `XHR` API 获取，重放时需自行补登录态（这一点同时写进了 `log.creator.comment`）
- 请求无 body 时不写 `postData`（HAR 惯例），`bodySize` 为 0
- `bodySize` / `content.size` 用拦截器上报的**原始字节数**（截断前），`content.text` 仍是截断后的文本，两者可以不一致
- 拿不到真实长度时（响应体是二进制、流式、读取中断，或升级前的旧记录没有该字段）按 HAR 规范写 `-1`，不用截断后的长度冒充
- `bodySize` 取的是解码后的字节数：`fetch` / XHR 拿不到传输层编码长度，gzip 压缩的响应下与线上实际字节数不同
- `response.cookies` 为空数组：`Set-Cookie` 语法复杂且我们只保留扁平化的响应头，Cookie 原文仍在 `headers` 里
- 响应体是浏览器解码后的文本，`Content-Encoding` 响应头保留原样
- `httpVersion` 固定标注为 `HTTP/1.1`，`statusText` 在 HTTP/2 下为空，都是 JS 层拿不到真实协议信息所致
- `entries` 按 `startedDateTime` 正序排列（不是按完成顺序）

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
