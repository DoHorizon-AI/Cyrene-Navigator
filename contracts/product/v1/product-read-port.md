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
