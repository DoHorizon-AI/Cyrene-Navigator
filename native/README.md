# Navigator native host / Navigator 原生宿主

This independent Cargo workspace provides Navigator-owned operating-system
adapters over versioned NDJSON on inherited stdin/stdout. It binds no listener
and has no dependency on a Platform source workspace or executable.

本目录是 Navigator 自有操作系统适配层的独立 Cargo workspace，通过继承的
stdin/stdout 传输版本化 NDJSON；它不监听端口，也不依赖 Platform 源码或可执行文件。

```bash
cargo build --manifest-path native/Cargo.toml --release -p cyrene-native-host
./native/target/release/cyrene-native-host
```

Requests and responses use protocol version `1` and caller-owned ids:

```json
{"version":1,"id":"req-1","method":"hello","params":{}}
{"version":1,"id":"req-1","result":{}}
```

Implemented methods are `hello`, `import_codex_rollout`, and `cancel`.
`import_codex_rollout` validates a bounded Codex JSONL archive, preserves its
digest and raw-file reference, and marks historical tool records non-executable.
EOF cancels outstanding work and joins workers before exit.

当前方法只有 `hello`、`import_codex_rollout` 和 `cancel`。导入操作对 Codex JSONL
做有界校验，保留摘要和原文件引用，并将历史工具记录标为不可执行。EOF 会取消并
回收全部未完成任务。
---
<!-- Chinese Translation / 中文翻译 -->

## 请求与响应

请求和响应都使用协议版本 `1` 以及由调用方拥有的 ID。请求可使用 `hello`、`import_codex_rollout` 或 `cancel` 方法；响应会原样回显请求 ID，并返回 `result` 或结构化错误。

已实现的方法为 `hello`、`import_codex_rollout` 和 `cancel`。`import_codex_rollout` 会对有界 Codex JSONL archive 执行校验、保留其摘要和原始文件引用，并将历史工具记录标记为不可执行。EOF 会取消未完成工作，并在进程退出前等待 worker 结束。
