# Navigator WebUI / Navigator 浏览器界面

This directory is a standalone Vite WebUI. It opens directly in the user's
browser and talks to Navigator through an HTTP API adapter. It has no embedded
WebView, native-process, or desktop-packaging dependency.

The current implementation is a source-preview shell: it renders the browser
surface, probes API availability, and links to the API documentation. It does
not yet render conversations or send/control Harness turns.

本目录是独立的 Vite WebUI，直接在浏览器中打开，通过 HTTP API 适配器连接 Navigator。
它不依赖嵌入式 WebView、本地进程或桌面打包。

当前实现是源代码预览 shell：渲染浏览器界面、探测 API 可用性并链接 API 文档，尚未渲染
会话或发送/控制 Harness turn。

| File | Responsibility / 职责 |
| --- | --- |
| `index.html` | HTML entry document and mount point / HTML 入口文档与挂载点 |
| `api.ts` | Browser-safe HTTP adapter boundary / 浏览器安全的 HTTP 适配器边界 |
| `main.ts` | WebUI rendering and API probe / WebUI 渲染与 API 探测 |
| `style.css` | WebUI visual styling / WebUI 视觉样式 |

Run `pnpm dev` to start Vite and open the browser automatically. Pass
`?api=http://127.0.0.1:8012` when the API is served on another origin.

执行 `pnpm dev` 会启动 Vite 并自动打开浏览器；API 在其他地址时使用
`?api=http://127.0.0.1:8012`。
