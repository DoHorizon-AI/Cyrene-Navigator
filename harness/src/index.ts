// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 harness/src/index.ts                                             │
// │  Module: Navigator Harness bundle root                               │
// │  Role: Expose the inert Host face while Profile composition loads the │
// │         concrete Cyrene adapters through their declared subpaths.    │
// │                                                                      │
// │  模块职责：Navigator Harness Bundle 根入口                           │
// │  · 保持 Host 入口无状态，避免新增 Agent Loop 或 Session authority     │
// │  · 由 Profile/patch 装配实际的 Cyrene 适配器                          │
// └─────────────────────────────────────────────────────────────────────┘

/**
 * Navigator bundle root.
 *
 * The bundle root is intentionally a small Host face.  Browser contributions
 * are discovered from the same package's `dsh.client` declaration and are
 * loaded through `./client`; keeping this Host face inert avoids a second
 * browser or Session authority.
 */

/** No Host services are required by the bundle root. */
export const inject: readonly string[] = []

/** Profile composition is supplied by the patch and the subpath entries. */
export function apply(): void {}
