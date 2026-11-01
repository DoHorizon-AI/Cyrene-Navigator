# Conversation Capability Adapters

This directory builds server-owned clients for the published Plugins
`model.provider.v1`, `memory.provider.v1`, `knowledge.graph.v1`,
`tool.provider.v1`, and `speech.provider.v1` contracts. It does not own user
memory policy, authorization decisions, or a second execution loop.

Every endpoint is supplied by the persistence process environment as a
loopback `grpc://` or absolute Unix connection reference. Each binding is
optional; a missing binding appears in `ConversationCapabilities.unavailable`
and leaves other adapters usable.

| Environment variable | Meaning |
|---|---|
| `CYRENE_NAVIGATOR_MODEL_PROVIDER_CONNECTION_REF` | Fixed `model.provider.v1` runtime. |
| `CYRENE_NAVIGATOR_MEMORY_PROVIDER_CONNECTION_REF` | Fixed `memory.provider.v1` runtime. |
| `CYRENE_NAVIGATOR_KNOWLEDGE_GRAPH_CONNECTION_REF` | Fixed `knowledge.graph.v1` runtime. |
| `CYRENE_NAVIGATOR_TOOL_PROVIDER_CONNECTION_REF` | Fixed `tool.provider.v1` runtime. |
| `CYRENE_NAVIGATOR_SPEECH_PROVIDER_CONNECTION_REF` | Fixed `speech.provider.v1` runtime. |
| `CYRENE_NAVIGATOR_EMBEDDING_MODEL_ID`, `CYRENE_NAVIGATOR_EMBEDDING_PROFILE_ID`, `CYRENE_NAVIGATOR_EMBEDDING_DIMENSIONS` | Server-bound embedding model identity, index profile and dimension. |
| `CYRENE_NAVIGATOR_EMBEDDING_DOCUMENT_PREFIX`, `CYRENE_NAVIGATOR_EMBEDDING_QUERY_PREFIX` | Distinct preprocessing for document and query inputs. Multilingual E5 requires `passage: ` and `query: `. |
| `CYRENE_NAVIGATOR_TOOL_BINDING_ID`, `CYRENE_NAVIGATOR_TOOL_CALLER_WORKLOAD`, `CYRENE_NAVIGATOR_TOOL_AUDIENCE`, `CYRENE_NAVIGATOR_TOOL_ISSUER` | Immutable signed tool caller identity pins. |
| `CYRENE_NAVIGATOR_TOOL_SIGNING_KEY_ENV`, `CYRENE_NAVIGATOR_TOOL_IDS` | Environment-variable name holding the 32-byte signer key, and the comma-separated allowlist of frozen tool IDs. |
| `CYRENE_NAVIGATOR_MEMORY_MAINTENANCE_TENANTS` | Server-only organization allowlist for tenant-wide prune RPCs. |
| `CYRENE_NAVIGATOR_SPEECH_ENABLED`, `CYRENE_NAVIGATOR_SPEECH_DEFAULT_LANGUAGE` | Safe speech feature defaults; user preference persistence is injected by the host. |

The tool key variable may contain 32 raw bytes, 64 hexadecimal characters, or
base64 encoding of 32 bytes. Only its environment-variable name is part of
ordinary configuration; caller payloads and API requests cannot select a key,
endpoint, model, actor, or organization.

| File | Responsibility |
|---|---|
| `config.py` | Read bounded local endpoint references, model profile, and signing environment references. |
| `runtime.py` | Pool local DirectPluginRuntime clients and validate typed envelopes. |
| `embeddings.py` | Adapt real model embeddings with distinct E5 document/query prefixes. |
| `memory.py` | Adapt all seven memory RPCs with actor/workspace/profile checks. |
| `knowledge_graph.py` | Apply and independently read back graph changesets; preserve source refs. |
| `peripheral.py` | Adapt tool and speech RPCs and construct the host trusted-caller signer. |
| `factory.py` | Compose configured adapters and report missing capabilities without secrets. |
| `README.md` | Document the ownership boundary, configuration, and verification entrypoints. |

Read `config.py` and `runtime.py` first, then the provider-specific adapter,
and finally `factory.py`. Unconfigured endpoints produce typed unavailable
capabilities; they never generate placeholder vectors or transcripts.

本目录将 Navigator 的服务端端口接到 Plugins 发布的 DirectPluginRuntime 契约；不持有记忆授权策略、用户状态或第二套执行循环。
缺少绑定时，组合结果会明确标记能力不可用，不生成占位向量或伪造转写。

所有 endpoint 只由 persistence 进程环境配置为 loopback gRPC 或绝对 Unix socket；各能力可单独缺省。多语言 E5 文档输入使用 `passage: `，查询输入使用 `query: `。工具 signer 只读取服务端指定的密钥环境引用，浏览器、请求体和模型均不能选择 identity、endpoint、model 或 organization。
