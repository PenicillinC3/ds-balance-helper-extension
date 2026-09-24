# DeepSeek 余额助手（Chrome / Edge 扩展）

实时监控 DeepSeek API 账户余额与 token 用量的轻量扩展，Manifest V3，纯原生 HTML + CSS + JavaScript，无任何第三方依赖。

~~**贫穷的作者因为前端创作而不想单开一个网页页面去看剩多少钱而做出来的产物QAQ**~~

## 功能

- **余额展示**：调用官方接口 `GET https://api.deepseek.com/user/balance`，大号字体显示可用余额，并展示充值余额、赠送余额、本地累计消耗、上次更新时间。
- **Token 用量统计（缓存命中 / 未命中）**：
  - 自动识别响应中的 `usage`，分别统计**缓存命中**（`prompt_cache_hit_tokens` / `cached_tokens` / `cache_read_input_tokens`）与**未命中**（`prompt_cache_miss_tokens` 等）token，并显示缓存命中率进度条；
  - 同时统计输入、输出、总 tokens、请求次数，支持**今日 / 累计**切换，累计视图按模型分组；
  - 兼容 OpenAI 兼容接口（`/chat/completions`、`/completions` FIM）、Responses API（`/responses`）、Anthropic 兼容接口（`/anthropic/v1/messages`）；
  - 普通 JSON 与 SSE 流式响应均可识别（流式请求需在调用时设置 `stream_options.include_usage=true`，DeepSeek 官方 SDK 默认开启）。
- **API Key 管理**：弹窗内输入，密码框 + 显示/隐藏切换；输入后自动验证有效性；密钥仅保存在 `chrome.storage.local`，绝不上传第三方。
- **低余额预警**：阈值可调（默认 5 元），一键开关；余额 ≤ 阈值时弹出浏览器系统通知，点击通知打开扩展弹窗；同一低余额状态 24 小时内只提醒 1 次。
- **后台自动刷新**：service worker 通过 `chrome.alarms` 定时查询，可选 5 / 10 / 30 / 60 分钟（默认 10 分钟）；未配置 Key 时不启动轮询。
- **自定义用量监控站点**：默认监控 DeepSeek 官方平台页（`platform.deepseek.com`）；若你在其他网页客户端里调用 DeepSeek API，可在设置中添加其网址（按需授权），扩展会注入拦截脚本统计该页用量。
- **应用内浮窗（所有网页可用）**：浮窗默认注入到你访问的**每一个网页**（顶层页面），直接显示余额与今日 token 用量（Shadow DOM 隔离，不读取、不影响宿主页内容）。设置面板「页面浮窗显示模式」可切换：
  - **悬浮窗（默认）**：在任意网页都可按住标题栏自由拖拽，位置自动记忆，窗口缩放时自动收回可视区；
  - **常驻右上角**：固定在页面右上角，不可拖拽；
  - **不显示浮窗**：也可直接点击浮窗右上角 × 关闭，随时在设置中重新开启。
  - 低余额时浮窗同步显示红色预警条（系统通知仍由后台统一发出，遵循 24 小时防重复规则）；浮窗内置刷新按钮，可立即查询。
  - 注：浏览器内置页面（`chrome://`、`edge://`、扩展商店等）禁止任何扩展注入，属于浏览器机制限制；本地 `file://` 页面需在扩展详情中开启「允许访问文件网址」。
- **完善错误提示**：网络异常、401 密钥无效、429 限流、5xx 服务异常、返回格式错误均有对应提示。

## 安装方式（加载已解压的扩展程序）

1. 解压本压缩包，得到 `deepseek-balance-helper` 文件夹。
2. Chrome 打开 `chrome://extensions/`；Edge 打开 `edge://extensions/`。
3. 打开右上角（Edge 在左侧）「开发者模式」。
4. 点击「加载已解压的扩展程序」，选择 `deepseek-balance-helper` 文件夹。
5. 点击工具栏扩展图标，在弹窗中输入 DeepSeek API Key（`sk-...`，可在 https://platform.deepseek.com/ 创建）。

## 文件结构

```
deepseek-balance-helper/
├── manifest.json          # MV3 配置（storage/notifications/alarms/scripting 权限）
├── background.js          # 后台 SW：定时查询、预警通知、防重复、用量汇总、动态站点注册
├── interceptor-main.js    # MAIN world 内容脚本：包装 fetch/XHR，提取 usage（含 SSE）
├── interceptor-bridge.js  # ISOLATED world 桥接：把拦截结果转发给后台
├── widget.js              # 应用内浮窗（Shadow DOM，悬浮拖拽 / 右上角常驻双模式）
├── popup.html             # 弹窗页面结构
├── popup.css              # 弹窗样式（340px，DeepSeek 品牌蓝卡片式）
├── popup.js               # 弹窗交互与本地存储读写
├── icons/                 # 16 / 48 / 128 图标
└── README.md
```

## 数据与隐私说明

- 所有数据（API Key、设置、余额快照、用量统计）只保存在浏览器本地存储中。
- 余额请求仅发往 `https://api.deepseek.com/*`，无任何第三方后端。
- 浮窗虽注入所有网页，但**只读取扩展本地存储中的余额/用量数据用于展示**，不读取、不上传任何网页内容，也不向宿主页发送数据。
- Token 用量通过在网页内只读拦截 DeepSeek 接口响应获得，**不修改任何请求/响应内容**，且拦截脚本仅注入 DeepSeek 官方平台页与你手动添加的监控站点；在你自己服务器/后端发起的调用，浏览器扩展无法捕获（这是浏览器扩展机制的固有限制）。
- DeepSeek 官方余额接口不返回“历史已消耗金额 / 总额度”，「已消耗」为本扩展依据相邻两次余额查询的下降差值在本地累计的估算值，卸载扩展即清零；「总额度」仅在接口返回该字段时自动显示。
