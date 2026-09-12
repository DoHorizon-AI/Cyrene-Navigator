# Native bridge fixtures / 原生桥测试固件

`native-matrix-host.mjs` is the POSIX executable, deterministic child used by
`native.integration.test.mjs`. `native-matrix-host.rs` contains the same
standard-library-only fixture for Windows, where the Node shebang is not an
executable process entry point. Compile the Rust source on Windows to a
native `.exe`; do not commit the generated binary.

Both fixtures speak the same newline-delimited JSON handshake and request
envelope as `cyrene-native-host`, while exposing controlled failure modes for
cancellation, timeout, protocol version errors, EOF/crash, and bounded output
checks.

`runNativeRequest` still launches it through the pinned DeepSeek Harness
`LocalSubprocessRuntime`; the fixture does not replace or wrap that runtime.
Each test writes its mode and state-file path to a task-local
`.cyrene-native-fixture.json` in the child working directory. The fixture never
executes a shell and prints diagnostics to stderr or deliberately invalid
protocol bytes to stdout only in the corresponding negative case.

这是仅供 `native.integration.test.mjs` 使用的可执行确定性子进程。它复现协议边界
故障，但测试仍通过固定版本的 `LocalSubprocessRuntime` 监督子进程；不替代运行时。

Windows 构建（在安装了 Rust 的 Developer PowerShell 中执行）：

```powershell
$source = Join-Path $PWD 'harness/tests/fixtures/native-matrix-host.rs'
$output = Join-Path $PWD 'harness/tests/fixtures/native-matrix-host.exe'
rustc --edition 2021 -C opt-level=2 $source -o $output
$env:CYRENE_NATIVE_MATRIX_BINARY = (Resolve-Path $output).Path
```

然后在同一环境运行真实监督矩阵：

```powershell
# Use the staged Node 24.13.0 before starting this shell.
node --version
$env:CYRENE_NATIVE_HOST = 'C:\path\to\cyrene-native-host.exe'
node --test harness/tests/native.integration.test.mjs
```

`node --version` must print `v24.13.0`; the Windows-only test assertion fails
for another Node runtime. Record the command output together with the staged
host paths when attaching P0-21/P0-23 evidence.

测试在 Windows 缺少 `native-matrix-host.exe` 时明确失败，不会回退到 `.mjs`
或把 POSIX 结果标成 Windows 通过。`CYRENE_NATIVE_MATRIX_BINARY` 可以指向安装包
验证目录中的同一构建产物；`LocalSubprocessRuntime` 仍以显式 `argv`、`shell:false`
启动它，因此包含空格的路径也会走真实 Windows 参数边界。
