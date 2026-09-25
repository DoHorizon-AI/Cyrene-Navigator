# Navigator-local Product read port

`ProductReadPort` is a Navigator application port and test seam:

```text
read(configuredOwnerUrl, relativeProductPath, traceparent) -> JSON object
```

It is not a Platform capability, cross-Product SPI, registration authority, or
contract that other Products implement. Its only consumers are Navigator
application code and tests. The HTTPX adapter enforces operator-configured base
URLs, forwards valid W3C trace context, applies finite timeouts, and returns the
owning Product's JSON without semantic rewriting. Transport and upstream RFC
9457 errors become Navigator observation problems only.

A future native-client adapter remains inside the same Navigator boundary. No
Product is required to depend on or implement this port.
---
<!-- Chinese Translation / 中文翻译 -->

# Navigator 本地 Product 读取端口

`ProductReadPort` 是 Navigator 的应用端口和测试接缝：

```text
read(configuredOwnerUrl, relativeProductPath, traceparent) -> JSON object
```

它不是 Platform capability、跨 Product SPI、注册权威，也不是要求其他 Product 实现的契约。它只由 Navigator 应用代码和测试使用。HTTPX 适配器强制使用操作员配置的 base URL，转发有效的 W3C trace context，采用有限超时，并原样返回 owner Product 的 JSON，不做语义改写。传输错误和上游 RFC 9457 错误只会转换为 Navigator 的观测问题。

未来的原生客户端适配器仍属于同一 Navigator 边界；没有 Product 需要依赖或实现此端口。
