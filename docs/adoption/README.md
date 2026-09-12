# Harness adoption ledger / Harness 接入记录

Navigator composes the exact DeepSeek Harness source declared by
`harness/upstream.lock.json`. Repository adapters are compiled from
`harness/src`, loaded through `harness/cordis.patch.yml`, and tested against the
real upstream packages.

## Owned adapters

- Persistence maps upstream Session events to Navigator's HTTP persistence
  authority with explicit leases and takeover.
- Codex import invokes the Navigator Rust host, preserves the source archive,
  and never replays historical tools.
- Client delivery feedback correlates submitted input with durable receipts and
  retains failed input for explicit recovery.
- Compaction removes tool declarations only for the compaction request and
  fails closed on outputs that contain no text.

The native host is launched through `CYRENE_NATIVE_HOST`. It has no external
Platform tool or source dependency. Its implemented methods are reported by the
`hello` handshake and remain limited to Navigator-owned operations.

## Compatibility and evidence

The profile tests use the real pinned Harness CLI, Bundle, Rust host, and local
persistence process. Deterministic model adapters used by focused tests are
fixtures and do not count as real model inference. Installed Windows smoke and
interactive GUI checks remain separate evidence lanes.

The native supervisor matrix retains cancellation, reaping, protocol-version,
bounded-output, and credential-isolation checks. Its controlled fault fixture
only tests the transport; Codex import still crosses the real Navigator Rust host.

Generated profile inventories are snapshots of the lockfile composition. They
must be regenerated when the Profile patch or upstream pin changes and must not
be treated as a runtime success claim.

## Upstream patch policy

Navigator keeps its changes in repository-owned Cordis plugins and client
extensions. A change to upstream Harness is proposed upstream or retained as an
explicit, reviewable adapter; it must not be hidden in an installation script.
