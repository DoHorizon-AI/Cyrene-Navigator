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
 * 中文：Navigator bundle 入口。该入口刻意只暴露精简的 Host 接口。浏览器扩展从同一包的 `dsh.client` 声明中发现，并通过 `./client` 子路径加载，避免聚合 Host/Client 类型进入浏览器构建。
 */

/** No Host services are required by the bundle root.  中文：Bundle 入口不需要任何 Host 服务。 */
export const inject: readonly string[] = []

/** Profile composition is supplied by the patch and the subpath entries.  中文：Profile 组合由 patch 和各子路径入口提供。 */
export function apply(): void {}
