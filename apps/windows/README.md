# Navigator native Windows client / Navigator 原生 Windows 客户端

A runnable WinUI 3 native client surface whose presentation layer is kept
separate from Navigator's browser WebUI and service contracts. Its runtime data
comes from the Navigator API through the `Core/Ports` adapters; the design/demo
fixtures in `Core/Mock` are a Debug-only preview mode and are excluded from
Release builds entirely.

Reads (session list, committed session events, run trace) are connected to the
Navigator persistence API. Control actions — sending a turn, cancelling a run,
answering an approval — require the Harness control route, which is not exposed
to this client yet; those actions fail closed with a typed
`NAVIGATOR_CONTROL_NOT_CONNECTED` error instead of changing local state.

This project is a native-client mode, not a WebView shell. It remains
non-packaged until its release signing policy is complete.

这是一个可以真正启动、浏览、点击、滚动的 WinUI 3 原生客户端界面。它与浏览器
WebUI 和 Navigator 服务契约分离；运行时数据经 `Core/Ports` 适配器来自 Navigator API，
`Core/Mock` 中的演示 fixture 仅在 Debug 预览模式使用，并在 Release 构建中被完全排除。

读取路径（会话列表、已提交会话事件、运行轨迹）已接入 Navigator 持久化 API。控制动作
（发送消息、取消运行、审批决策）需要 Harness 控制通道，目前尚未向本客户端开放；这些
动作以 `NAVIGATOR_CONTROL_NOT_CONNECTED` 类型化错误 fail closed，不会在本地伪造状态。

本模式不是 WebView 壳。发布签名策略完成前仍不打包发布。

---

## Run it / 运行

```powershell
cd Services\Cyrene-Navigator\apps\windows
.\build.ps1
```

Requires Windows 10 build 19041 or newer and the .NET 8 SDK (or newer) — nothing else. The
project is **unpackaged and framework-dependent** by default, so there is no MSIX signing step.
Use `-SelfContained` when the target machine does not have the Windows App Runtime.

Add `-Fonts` on the first run to install Space Grotesk, the brand display face. Without it the
app falls back to Segoe UI Variable Display, which still looks correct and native.

```powershell
.\build.ps1 -Fonts            # install the brand display face, then build and run
.\build.ps1 -NoRun            # build only
```

---

## Connect to the Navigator API / 连接 Navigator API

The client reads from the workspace-scoped Harness persistence service. Configure it with
environment variables before launching:

```text
CYRENE_NAVIGATOR_API_URL   http://127.0.0.1:8012      # Navigator API base URL
CYRENE_NAVIGATOR_API_TOKEN <principal bearer token>   # configured service credential
CYRENE_NAVIGATOR_WORKSPACE <workspace id>             # workspace the principal may read
```

Without these, the client starts in an explicit not-configured state and says so in the session
header and workspace page — it never falls back to fixtures. The Debug preview stays available
for design work:

```powershell
$env:CYRENE_NAVIGATOR_UI_PREVIEW = 'mock'
.\build.ps1
```

Release builds do not compile `Core/Mock`, so `CYRENE_NAVIGATOR_UI_PREVIEW` has no effect there.

---

## What to look at / 看什么

| Destination | Keyboard | What it is there to prove |
| --- | --- | --- |
| Sessions | `Ctrl+1` | The main conversation. ~165 timeline rows: long markdown, Python/Rust/JSON/bash code, four tool families, a failed connector, a diff, an artifact, a settled approval, a blocked approval, a live agent trace, and a streaming tail. |
| Activity | `Ctrl+2` | Long-running work. Runs ordered by whether they need you, with the full step trace. |
| Workspace | `Ctrl+3` | Resources as a spec sheet: models, GPU nodes, endpoints, users, usage. |
| Settings | `Ctrl+4` | Windows-native settings, including a theme switch that really works. |

Other shortcuts: `Ctrl+L` focus the composer, `Ctrl+M` open the model picker, `Ctrl+B` collapse
the rail. Right-click almost anything — messages, tool cards, artifacts, session rows, resource
rows — for a native context menu.

Things worth doing by hand:

- Scroll the transcript from top to bottom and watch the trace line change weight.
- Expand a tool card, then the failed connector.
- Answer the approval card at the bottom.
- Open the model picker and read how the groups are labelled.
- Switch to dark mode in Settings › Appearance.

---

## The design language / 设计语言

Derived from the Do Horizon brand stylesheet, then developed into something a desktop client can
actually be built out of.

**The trace.** A 1.5px line runs down the left gutter of every timeline row; content hangs off it
through short hairline elbows, and diamond nodes mark the junctions that matter — a turn, an
artifact, a decision, the thing running now. Through settled history it is a neutral hairline;
one row before the live region it rises into brand colour; from there down it is one continuous
coral→orchid gradient split across the live rows, and it arrives at the composer's top edge. It
is not decoration: it is where the run has got to.

**Warm paper, hairline structure.** The canvas is `#FBFAF8`, not white. Structure is drawn with
1px `#E9E5E1` lines and a radius set of 2/3/4/6/8 — no shadows, no card walls. Lists and resource
sheets are hairline rows, so high information density stays legible.

**Colour as ink, never as fill.** The brand gradient (coral `#F2918C` → rose `#D98AB7` → orchid
`#C77FD6`) appears in exactly five roles: the trace, the active navigation indicator, the 1.5px
edge on decision-bearing cards, emphasised numerals, and the horizon rules. Primary buttons are
ink on paper — the same choice the website makes.

**Documents, not bubbles.** Assistant turns sit directly on the paper at a single reading measure
with no container. User turns get a recessed sand card. The two voices are distinguished by
surface rather than by which side of the screen they are on, which is what makes a long session
read like a working document.

**System layer stays system.** Mica, the extended title bar with real caption buttons, the
navigation rail's hover/pressed/selected behaviour, context menus, dialogs, file pickers,
ToggleSwitch/ComboBox/Slider — all platform. What changed is the palette those templates resolve
against (`Themes/Overrides.xaml`), plus one deliberate crossover: focus rings are orchid, matching
the website's `:focus-visible`.

---

## Layout / 目录

```
apps/windows/
├── build.ps1                     One-command build and launch
├── Cyrene.Navigator.Windows.sln
├── src/Cyrene.Navigator.Windows/
│   ├── App.xaml(.cs)             Application root — one of only two XAML files
│   ├── MainWindow.cs             Mica, title bar, rail, accelerators: the system layer
│   ├── AppHost.cs                HWND/XamlRoot plumbing for pickers and dialogs
│   ├── Themes/Overrides.xaml     Retints WinUI's own controls to the Cyrene palette
│   ├── Design/
│   │   ├── Palette.cs            Raw brand colours, light and dark
│   │   └── Tokens.cs             Semantic tokens: fills, lines, gradients, spacing,
│   │                             radius, typography, motion, syntax colours
│   ├── PortComposition.cs        Composition root: API adapters by default, preview in Debug
│   ├── Core/
│   │   ├── Models.cs             Timeline, run, session, model, usage, resource shapes
│   │   ├── Ports/                UI-neutral conversation, run-state and presentation interfaces
│   │   ├── Api/                  NavigatorApiClient, event projection, API adapters
│   │   ├── PresentationLabels.cs Client-side tier/tool label vocabulary
│   │   ├── StreamingScript.cs    Deterministic stream fixture used by the preview adapter
│   │   ├── Mock/                 Debug-only preview fixtures (excluded from Release builds)
│   │   └── Text/                 Markdown parser, syntax tokenizer
│   ├── Controls/
│   │   ├── Primitives.cs         Type ramp, cards, chips, diamonds, horizon rules, meters
│   │   ├── TraceGutter.cs        The gradient trace — the core motif
│   │   ├── VirtualList.cs        Virtualized heterogeneous list
│   │   ├── MarkdownView.cs       Block renderer with incremental streaming updates
│   │   ├── CodeBlockView.cs      Two-TextBlock code block with its own height cap
│   │   ├── MessageView.cs        Turns, day dividers, context notices
│   │   ├── ToolCard.cs           Collapsed-by-default tool invocations
│   │   ├── ApprovalCard.cs       Gradient-edged decision card
│   │   ├── ArtifactCard.cs       Artifacts with preview and native save
│   │   ├── DiffView.cs           Unified diff with a +/- gutter
│   │   ├── AgentProgress.cs      The run trace
│   │   ├── UsageIndicator.cs     Inline, compact and stat forms
│   │   ├── ModelSelector.cs      Grouped by where the model runs
│   │   ├── Composer.cs           One input plus a context strip
│   │   ├── CyreneNavigation.cs   Primary rail
│   │   └── SessionList.cs        Session list
│   └── Views/                    SessionsPage, ConversationView, ActivityPage,
│                                 WorkspacePage, SettingsPage
└── tools/
    ├── check.sh                  Offline verification (see below)
    ├── typecheck/                Headless Roslyn compile of every non-XAML source file
    ├── adaptercheck/             Headless behaviour check of the API adapter layer
    └── xamlcheck.py              XAML well-formedness, key scoping, palette agreement
```

---

## Performance decisions / 性能设计

The prototype is built the way the real client has to be built, so nothing here has to be
redesigned later to make it fast.

- **Virtualized timeline from the start.** `VirtualList` is built on `ItemsRepeater` + an
  `IElementFactory` that materialises product-layer views directly from model objects, with no
  DataTemplate pipeline and no `.ToString()` fallback. ~165 rows instantiate the dozen on screen
  plus the cache.
- **Parse once.** Markdown block lists and syntax token streams are cached on the timeline item,
  not in the view, so scrolling back through the transcript re-creates views but never re-parses.
- **Streaming touches one row.** `MarkdownView.UpdateStreaming` diffs block signatures and
  rebuilds only what changed — in practice the trailing block. A token arriving never re-lays-out
  the history above it.
- **Blocks own their size.** Code blocks declare a height cap and scroll internally, and overflow
  horizontally inside themselves. No code line can widen the page and no long block can make the
  transcript resize while it streams.
- **Tool output is collapsed.** Nothing expands a large payload by default.
- **One timer.** A single 90ms tick drives the run trace, the streaming tail and the elapsed
  clocks, instead of one timer per animated element.

---

## Verification without a Windows machine / 无 Windows 环境下的校验

The WinUI XAML compiler is Windows-only, but the Windows App SDK's managed projections are
ordinary .NET assemblies. `tools/check.sh` uses that to verify the prototype from Linux, macOS or
CI:

```bash
bash tools/check.sh
```

1. **Type check, Debug** — `tools/typecheck/TypeCheck.csproj` compiles every source file except
   `App.xaml.cs` against `net8.0-windows10.0.26100.0` with `EnableWindowsTargeting`. Because the
   product layer is written in C# rather than XAML, this is a real Roslyn compile of the whole
   control and view layer.
2. **Type check, Release** — the same compile with `-c Release`, where `Core/Mock` is excluded.
   A Release-only misuse of a preview fixture fails here, in CI, and on any developer machine.
3. **XAML check** — `tools/xamlcheck.py` validates well-formedness, per-dictionary key
   uniqueness, resource references, code-behind presence, and that the hex values duplicated into
   `Themes/Overrides.xaml` still agree with `Design/Palette.cs`.
4. **UI boundary check** — Views and Controls must not import the fixture namespace.
5. **API adapter check** — `tools/adaptercheck/` links the real `Core/Api` sources into a plain
   .NET console app, drives them with scripted HTTP responses and Harness event fixtures, and
   asserts the projections, session mapping, encoded request paths, and typed error codes.

This does not replace building on Windows; it catches the class of mistake that would otherwise
only appear on someone else's machine.

---

## Out of scope / 本轮不做

No Harness control channel (send, cancel, approve), no workspace metric or model-catalogue
contract, no Platform changes, no macOS or Linux, no SSO, no plugin system. The UI depends only
on `Core/Ports/IConversationService`, `Core/Ports/IAgentState` and
`Core/Ports/INavigatorUiData`; the API adapters and the preview fixtures are interchangeable
composition-root choices. The boundary check in `tools/check.sh` prevents Views and Controls from
importing the fixture namespace, and the Release build excludes it outright.
