# Navigator UI modes / Navigator UI 模式

Navigator has two presentation modes with one service boundary:

1. `apps/desktop` is the standalone browser WebUI. `pnpm dev` opens it in a
   browser, and `?api=<url>` selects a Navigator API origin.
2. `apps/windows` is the native WinUI client surface. It has its own native
   windowing and presentation code and is checked independently from the WebUI.

The Rust `native/` workspace is an integration/process host used by the native
acceptance matrix. It is not a UI shell and does not own browser or WinUI
presentation state.

The browser surface is currently a standalone API probe/preview. The native
surface is an `API_CONNECTED_PROTOTYPE`: reads are connected through
`Core/Ports`, but send, cancel, and approve require a Harness control route that
is not exposed yet. The Windows project is unpackaged and unsigned; neither
surface is a finished binary release.

浏览器交付面当前是独立的 API probe/preview。原生交付面是
`API_CONNECTED_PROTOTYPE`：读取经 `Core/Ports` 接通，但发送、取消和审批需要尚未开放的
Harness 控制通道。Windows 工程目前不打包且未签名；两种交付面都不是完成的二进制发布物。

Navigator 有两种展示模式，共享同一服务边界：

1. `apps/desktop` 是独立浏览器 WebUI，`pnpm dev` 会直接打开浏览器，使用
   `?api=<url>` 指定 Navigator API 地址。
2. `apps/windows` 是原生 WinUI 客户端界面，拥有自己的窗口和展示代码，与 WebUI
   分开验证。

Rust `native/` workspace 是原生验收矩阵使用的进程/集成 host，不是 UI 壳，也不拥有
浏览器或 WinUI 的展示状态。

## Acceptance / 验收

```bash
pnpm --dir apps/desktop install --frozen-lockfile
pnpm --dir apps/desktop build
cargo test --manifest-path native/Cargo.toml --workspace --all-targets --locked
bash apps/windows/tools/check.sh
```

Windows CI additionally runs the WinUI type-check and native supervisor matrix.
