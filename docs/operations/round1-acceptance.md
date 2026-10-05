# Round 1 integration acceptance / 第一轮集成验收

This page records the repeatable, local acceptance path for the round 1
Navigator work. Evidence is separated into code-backed tests, deterministic
simulations, and credentialed or native-runtime checks. A fixture test never
stands in for an external account, a cloud deployment, or a real model call.

本文记录第一轮 Navigator 工作的可重复本地验收路径，并区分代码测试、确定性模拟，
以及依赖凭据或原生运行环境的检查。夹具测试不能替代外部账号、云端部署或真实模型调用。

## Evidence labels / 证据标签

| Label | Meaning |
| --- | --- |
| `PASS` | The named command ran against this checkout and met its stated assertions. |
| `SIMULATED` | Deterministic local fixtures exercised the boundary; no real provider action occurred. |
| `NOT_RUN` | The required credential, account, operating system, device, or deployment was unavailable or outside this round. |
| `FAIL` | The named command ran and an assertion or build gate failed. |

| 标签 | 含义 |
| --- | --- |
| `PASS` | 当前检出版本运行了所列命令，且满足命令声明的断言。 |
| `SIMULATED` | 本地确定性夹具覆盖了边界；没有调用真实服务商或执行外部动作。 |
| `NOT_RUN` | 缺少所需凭据、账号、操作系统、设备或部署，或本轮范围不包括该项。 |
| `FAIL` | 所列命令已运行，但断言或构建门禁失败。 |

## Round 1 local acceptance / 第一轮本地验收

| Path | Required evidence | Result |
| --- | --- | --- |
| Normalized WeCom inbound to a durable Navigator task | Fake normalized connector event is admitted once; task and connector receipt remain readable after SQLite is reopened. | `SIMULATED` — `node --test harness/tests/round1.integration.test.mjs` (1/1). Companion Plugins fixtures cover WeCom callback normalization; no WeCom account was used. |
| DSH model turn, subagent request, and approval gate | Fake Exchange model turn invokes the Antigravity protocol fixture; approval and rejection leave durable decisions. | `SIMULATED` — same round-one vertical, 1/1; no CLI account or real model was used. |
| Notification handoff | Fake connector starts and finishes one outbox lease; exact retries replay the stored receipt and a denied task cannot enqueue a new notification. | `SIMULATED` — same round-one vertical, 1/1; no real message was sent. |
| Exchange transport | Local HTTP fixture verifies authenticated OpenAI-compatible routing and streamed success; a separate custom model adapter fixture covers model failure, cancellation, and restart recovery. | `SIMULATED` — `executor.integration.test.mjs`; no remote Exchange provider call. |
| Exchange Product service | The local Exchange Product CLI serves a temporary database and routes through a loopback mock provider; Gateway authentication, target-model routing, and upstream failure mapping are checked. | `SIMULATED` — local Product CLI: control route 201, unauthenticated Gateway 401, mock provider success 200, upstream 429 mapped to 502. Remote tenant/provider call remains `NOT_RUN`. |
| QQ login surface | Fixture Host exercises QR expiry and account-health state transitions. This is protocol evidence only. | `SIMULATED` — companion Plugins QQ Host fixture/TCK; real QQ login and message traffic remain `NOT_RUN`. |
| Organization and Workspace scope | Read-only principal cannot create a Harness Session; owner cannot read a task in another Workspace; Work records survive service restart. | `SIMULATED` — same round-one vertical, 1/1. |
| Cloud profile surface | Local HTTP/stdio MCP and bounded read-only CLI fixtures; no resource mutation. | `SIMULATED` — `node --test harness/tests/cloud-connections.integration.test.mjs` (2/2); no cloud credentials used. The five combined cloud/workflow tests are included in the 32/32 command below. |

At `b15a2935d4e07967ab29ae08c3b43e70b1ecdf48`, the combined headless gate
used Node 24.13.0 and passed 32/32 tests with no skips (31 core fixtures plus
the round-one vertical):

```sh
PATH="/home/baijin/.cache/cyrene-hermes-round1/toolchain/node-v24.13.0-linux-x64/bin:$PATH" \
  node --test \
    harness/tests/executor.integration.test.mjs \
    harness/tests/subagents.test.mjs \
    harness/tests/tool-providers.test.mjs \
    harness/tests/work-tools.test.mjs \
    harness/tests/workflows.integration.test.mjs \
    harness/tests/cloud-connections.integration.test.mjs \
    harness/tests/round1.integration.test.mjs
```

At the same revision, the local Python gate passed with `uv run pytest -q` (83
tests). These exact quality gates also passed:

```sh
uv run ruff check src tests scripts/serve-persistence.py scripts/serve-web.py scripts/serve-local.py scripts/export-work-openapi.py
uv run ruff format --check src tests scripts/serve-persistence.py scripts/serve-web.py scripts/serve-local.py scripts/export-work-openapi.py
uv run mypy src/cyrene_navigator scripts/serve-persistence.py scripts/serve-web.py scripts/serve-local.py scripts/export-work-openapi.py
PATH="/home/baijin/.cache/cyrene-hermes-round1/toolchain/node-v24.13.0-linux-x64/bin:$PATH" \
  node .upstream/deepseek-harness/node_modules/typescript/bin/tsc -p harness/tsconfig.json --pretty false
```

All three Work OpenAPI contract validators passed. The exact-head Docker image
build and container smoke also passed at `b15a2935d4e07967ab29ae08c3b43e70b1ecdf48`:

```sh
docker build --quiet -f Dockerfile.executor -t cyrene-navigator-executor:round1-b15a2935 .
```

The smoke ran the paired stack as its non-root image user with a named `/data`
volume, received HTTP 200 from `/api/v1/system/status` before and after a
container restart, and verified that the SQLite file remained present. The
Exchange endpoint was a local unused fixture; no model/provider request or
external action occurred. This is local image and persistence evidence, not a
hosted registry or deployment acceptance.

Use the targeted commands recorded by each owning test module. The integration
proof must report the exact commands and statuses; do not convert `SIMULATED`
into `PASS` for a real connector or provider.

应使用各测试模块记录的定向命令。集成证明必须逐项报告实际命令和状态；不能把
`SIMULATED` 改写为真实连接器或服务商的 `PASS`。

## Runtime and package targets / 运行时与包目标

The committed Navigator workflows configure Linux x86_64 CI, a separate Linux
arm64 native/build/headless integration job, Ubuntu 22.04 and 24.04 x86_64
Python component packages, and a Windows x64 native plus headless Python/Node
fixture job. Hosted ARM64 and Windows runs are still required before those
targets have CI acceptance. The arm64 job does not publish an arm64 Python
component package. The Windows job does not show a signed MSIX installer or a
real QQ desktop session.

当前 Navigator 工作流配置了 Linux x86_64 CI、单独的 Linux arm64 原生构建与无头集成作业、
Ubuntu 22.04 与 24.04 x86_64 Python 组件包，以及包含原生和无头 Python/Node 夹具的
Windows x64 作业。Hosted ARM64 与 Windows 作业仍需实际运行后才算通过；arm64 作业不发布
Python 组件包。Windows 作业不表示已有签名 MSIX 安装程序或真实 QQ 桌面会话。

| Target | Evidence source | Acceptance status |
| --- | --- | --- |
| Linux x86_64 Navigator tests and native host | `.github/workflows/ci.yml` | Run locally where supported; hosted CI remains the target gate. |
| Linux x86_64 Python component packages | `.github/workflows/component-release.yml` on Ubuntu 22.04 and 24.04 | Build and manifest evidence required per target profile. |
| Linux arm64 Navigator native build and headless tests | `.github/workflows/native-arm64.yml` on `ubuntu-24.04-arm` | Workflow added; hosted ARM64 run required. This is not a published Python component package. |
| Windows x64 native and headless fixtures | `.github/workflows/native-windows.yml` on `windows-2025` | Workflow extended; hosted Windows run required; a Linux cross-check is not equivalent. |
| Linux arm64 Python component package | No current component-release profile | `NOT_RUN` until a release profile and artifact manifest are added. |
| Windows arm64 package | No current Navigator release workflow target | `NOT_RUN` until a target and runner are added. |

## External and cutover gates / 外部服务与切换门禁

Real WeCom credentials and delivery, real QQ QR login and message traffic,
credentialed Exchange/model turns, authenticated cloud profiles, and deployment
or VM cutover require their own explicitly configured environments. They remain
`NOT_RUN` until evidence from those environments exists. This proof uses local
fake services and must not send external messages, change cloud resources, or
redirect live traffic.

真实企业微信凭据与投递、真实 QQ 二维码登录与消息流量、带凭据的 Exchange/模型回合、
经过身份验证的云配置以及部署或 VM 切换都需要单独配置环境。只有取得这些环境中的证据
后，状态才能从 `NOT_RUN` 更新。本证明使用本地模拟服务，不得发送外部消息、变更云资源或
切换线上流量。
