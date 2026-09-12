# Navigator client aggregation contract v1

Status: `HEADLESS_MVP_READY`; real HTTP fan-out is implemented, while browser
and native-client adapters remain separate boundaries.

Navigator owns presentation and client aggregation, not Product resource state.
`WorkspaceSnapshot` is an observed view produced on demand; it is neither
durable authority nor an event-sourced projection.

## Boundary

- Configured Product base URLs are operator-owned directory data.
- Each `ProductView` preserves `product`, `sourceUrl`, `observedAt`, and the
  owner's unmodified JSON object.
- Navigator never changes Product state labels, infers readiness, or converts a
  provider/package/binding into Product identity.
- A remote error becomes an `UNAVAILABLE` view with a typed observation problem;
  healthy Product views remain usable and the snapshot becomes `PARTIAL`.
- Mutations are not accepted. A future UI action must forward a typed command to
  the owning Product API.
- W3C `traceparent` and optional `tracestate` are propagated to each Product
  request when the incoming trace identity is valid.
- `ProductReadPort` is a Navigator-local application/test seam. It is not a
  global Product SPI and no other Product implements it.

## Notifications

Navigator emits no Product lifecycle events because `WorkspaceSnapshot` is an
ephemeral query result. It may emit OpenTelemetry spans/metrics, but those never
become Product notifications or durable state. UI actions must send commands to
the owning Product, whose notification catalog remains authoritative.

## Compatibility

The aggregation API is `/api/v1`, OpenAPI 3.1.2, and JSON Schema Draft 2020-12;
it consumes the Workspace `product-http-v1` compatibility profile.
The POST is a safe, non-mutating query chosen only because the read set is a
structured body; it does not use `Idempotency-Key` or create a resource.

Deprecation, migration window, and removal follow the common profile.
Reinterpreting owner state or changing partial-failure semantics requires v2.
