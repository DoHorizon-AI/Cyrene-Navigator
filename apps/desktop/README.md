# Navigator browser WebUI / Navigator 浏览器 WebUI

This package is the browser WebUI for Cyrene Navigator. It is a standalone Vite
application and opens directly in a browser. Native lifecycle, persistence, and
process supervision stay outside this UI package.

这是 Cyrene Navigator 的浏览器 WebUI，作为独立 Vite 应用直接在浏览器中打开。原生
生命周期、持久化和进程监督不放在 UI 包内。

| Path | Responsibility / 职责 |
| --- | --- |
| [`ui/`](ui/README.md) | Standalone browser UI and HTTP adapter / 独立浏览器 UI 与 HTTP 适配器 |
| `package.json` | Vite build, dev, and browser preview commands / Vite 构建、开发和浏览器预览命令 |
| `vite.config.ts` | Frontend development and production output / 前端开发和生产输出 |
| `tsconfig.json` | Strict frontend type-checking / 前端 strict 类型检查 |

Run `pnpm dev` to start Vite and open the browser automatically. Pass
`?api=http://127.0.0.1:8012` when the API is served on another origin.

执行 `pnpm dev` 会启动 Vite 并自动打开浏览器；API 在其他地址时使用
`?api=http://127.0.0.1:8012`。

The separate native client lives under [`../windows/`](../windows/README.md). Both modes
consume product/API contracts; neither owns product state or the identity control plane.

独立的原生客户端位于 [`../windows/`](../windows/README.md)。两种模式都消费
Product/API contract；两者都不拥有 Product 状态或身份控制面。
