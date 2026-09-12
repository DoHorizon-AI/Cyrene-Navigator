// Core/Mock/MockConversationService.cs
//
// Mock session list and conversation timeline / 会话列表与对话时间线（mock）。
//
// The timeline is produced as one flat, ordered list of heterogeneous items — the exact shape a
// virtualized list needs. Around 130 rows are generated so scrolling behaviour can actually be
// judged, with a hand-authored recent section carrying every state the design has to prove:
// long markdown, Python/Rust/JSON code, four tool families, a failure, an artifact, a diff,
// a settled approval, a blocked approval, a live run, and a streaming tail.
//
// 替换成真实 API 时只需实现 Core.IConversationService。

using System;
using System.Collections.Generic;
using System.Globalization;

namespace Cyrene.Navigator.Windows.Core.Mock;

public sealed class MockConversationService : IConversationService
{
    private static readonly DateTimeOffset Now = new(2026, 9, 6, 14, 32, 0, TimeSpan.FromHours(8));

    private int _seq;

    // -----------------------------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------------------------

    public IReadOnlyList<SessionSummary> Sessions() => new List<SessionSummary>
    {
        new()
        {
            Id = "s-live",
            Title = "Harness session contract rename",
            Project = "example-project",
            Preview = "Reproducing the failure — pytest tests/harness/test_adapter.py",
            UpdatedAt = Now,
            Activity = SessionActivity.Running,
            ModelLabel = "Example Chat",
            TurnCount = 68,
            IsPinned = true,
            Bucket = "Now",
        },
        new()
        {
            Id = "s-migration",
            Title = "Apply pending alembic revision",
            Project = "example-project",
            Preview = "Waiting for your approval — writes to demo-workspace",
            UpdatedAt = Now - TimeSpan.FromMinutes(4),
            Activity = SessionActivity.AwaitingApproval,
            ModelLabel = "Example Coder",
            TurnCount = 12,
            IsPinned = true,
            Bucket = "Now",
        },
        new()
        {
            Id = "s-catalog",
            Title = "Exchange catalogue sync keeps 503-ing",
            Project = "example-platform",
            Preview = "Fetch catalogue failed — shard demo-shard-1 draining",
            UpdatedAt = Now - TimeSpan.FromMinutes(22),
            Activity = SessionActivity.Failed,
            ModelLabel = "Example Local 32B",
            TurnCount = 9,
            Bucket = "Today",
        },
        new()
        {
            Id = "s-docs",
            Title = "Rewrite docs/API.md session section",
            Project = "example-project",
            Preview = "Produced docs/API.session.md · 3 sections replaced",
            UpdatedAt = Now - TimeSpan.FromHours(1) - TimeSpan.FromMinutes(35),
            ModelLabel = "Example Analyst",
            TurnCount = 34,
            Bucket = "Today",
        },
        new()
        {
            Id = "s-native",
            Title = "Native host fs.watch debounce",
            Project = "example-project",
            Preview = "Landed — 120ms coalescing window, 14 tests added",
            UpdatedAt = Now - TimeSpan.FromHours(3),
            ModelLabel = "Example Chat",
            TurnCount = 51,
            Bucket = "Today",
        },
        new()
        {
            Id = "s-usage",
            Title = "Why did last week's spend double?",
            Project = "demo-workspace",
            Preview = "Cache miss rate on the eval pipeline, not model pricing",
            UpdatedAt = Now - TimeSpan.FromHours(5) - TimeSpan.FromMinutes(10),
            ModelLabel = "Example Reasoner",
            TurnCount = 22,
            Bucket = "Today",
        },
        new()
        {
            Id = "s-gpu",
            Title = "Schedule Example Multimodal eval on the Demo GPU Pool",
            Project = "demo-workspace",
            Preview = "Queued 6 shards, 2h estimated",
            UpdatedAt = Now - TimeSpan.FromDays(1) - TimeSpan.FromHours(2),
            ModelLabel = "Example Multimodal",
            TurnCount = 18,
            Bucket = "Yesterday",
        },
        new()
        {
            Id = "s-plugin",
            Title = "Plugin manifest v2 migration notes",
            Project = "example-plugins",
            Preview = "14 plugins need the new capability block",
            UpdatedAt = Now - TimeSpan.FromDays(1) - TimeSpan.FromHours(6),
            ModelLabel = "Example Coder",
            TurnCount = 41,
            Bucket = "Yesterday",
        },
        new()
        {
            Id = "s-redact",
            Title = "Offline redaction pass on support transcripts",
            Project = "demo-workspace",
            Preview = "Ran fully on-device · 2 140 transcripts",
            UpdatedAt = Now - TimeSpan.FromDays(1) - TimeSpan.FromHours(9),
            ModelLabel = "Example Local 8B",
            TurnCount = 7,
            Bucket = "Yesterday",
        },
        new()
        {
            Id = "s-titlebar",
            Title = "Windows title bar drag regions",
            Project = "example-project",
            Preview = "Fixed — caption buttons were eating pointer input",
            UpdatedAt = Now - TimeSpan.FromDays(3),
            ModelLabel = "Example Chat",
            TurnCount = 29,
            Bucket = "This week",
        },
        new()
        {
            Id = "s-stream",
            Title = "Streaming reflow jank in the composer",
            Project = "example-project",
            Preview = "Only the tail block re-renders now",
            UpdatedAt = Now - TimeSpan.FromDays(4),
            ModelLabel = "Example Reasoner",
            TurnCount = 63,
            Bucket = "This week",
        },
        new()
        {
            Id = "s-sso",
            Title = "Workspace identity: what we owe the platform team",
            Project = "example-platform",
            Preview = "Navigator does not own identity — deferred",
            UpdatedAt = Now - TimeSpan.FromDays(5),
            ModelLabel = "Example Analyst",
            TurnCount = 15,
            Bucket = "This week",
        },
        new()
        {
            Id = "s-bench",
            Title = "Latency budget for a 2M-context read",
            Project = "demo-workspace",
            Preview = "Under 200ms end-of-turn is achievable with prefix cache",
            UpdatedAt = Now - TimeSpan.FromDays(11),
            ModelLabel = "Example Analyst",
            TurnCount = 26,
            Bucket = "Earlier",
        },
        new()
        {
            Id = "s-onboard",
            Title = "First-run experience for a new workspace member",
            Project = "example-project",
            Preview = "Three screens, no tour",
            UpdatedAt = Now - TimeSpan.FromDays(18),
            ModelLabel = "Example Chat",
            TurnCount = 38,
            Bucket = "Earlier",
        },
    };

    // -----------------------------------------------------------------------------------------
    // Timeline
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Builds the full timeline for the live session. Order is oldest-first; the caller scrolls
    /// to the end. Trace roles are assigned in one pass at the end so the gradient spine only
    /// lights up around the live region.
    /// </summary>
    /// <summary>Preview fixtures are a local demo mode, never a Navigator API connection.</summary>
    public bool IsConnected => false;

    public string ConnectionDetail => "Preview fixtures: no Navigator API is connected.";

    /// <summary>The preview keeps its local demo interaction; it never claims a real send.</summary>
    public bool CanSubmit => true;

    /// <summary>The preview transcript is a single fixture; switching sessions keeps it.</summary>
    public void OpenSession(string sessionId)
    {
        _ = sessionId;
    }

    public IReadOnlyList<TimelineItem> Timeline()
    {
        var items = new List<TimelineItem>();
        BuildHistory(items);
        BuildRecent(items);
        AssignTrace(items);
        return items;
    }

    /// <summary>The tail message that types itself in, to exercise the streaming treatment.</summary>
    public StreamingScript StreamingTail() => new(
        "Reproduced it. The failure is not in the adapter at all — `SessionContract.authority_ref` is "
        + "resolved **before** the transport handshake completes, so on a cold connection the field is "
        + "still `None` when the assertion runs.\n\n"
        + "Two ways forward:\n\n"
        + "1. Resolve the authority lazily at first use. Smallest change, keeps the contract honest, but "
        + "every call site has to tolerate a deferred value.\n"
        + "2. Await the handshake inside `SessionContract.bind()`. Larger change, but the invariant then "
        + "holds everywhere and the test can stay exactly as written.\n\n"
        + "I'd take the second one — the contract is the thing we do not want to loosen. Let me show you "
        + "the shape before I touch anything.");

    private void BuildHistory(List<TimelineItem> items)
    {
        // Procedurally generated back-history. Content rotates through real project topics so a
        // long scroll never repeats visibly, which is what makes scroll testing meaningful.
        var start = Now - TimeSpan.FromHours(6);
        var dayLabelled = false;

        for (var i = 0; i < HistoryTopics.Length; i++)
        {
            var topic = HistoryTopics[i];
            var at = start + TimeSpan.FromMinutes(i * 4.5);

            if (!dayLabelled)
            {
                items.Add(new DayDividerItem { Id = Next("day"), At = at, Label = "Earlier today · 08:32" });
                dayLabelled = true;
            }

            items.Add(new TurnItem
            {
                Id = Next("t"),
                At = at,
                Role = TurnRole.User,
                Author = "You",
                Markdown = topic.Ask,
                Node = NodeKind.Anchor,
            });

            items.Add(new TurnItem
            {
                Id = Next("t"),
                At = at + TimeSpan.FromSeconds(9),
                Role = TurnRole.Assistant,
                Author = "Assistant",
                ModelLabel = i % 5 == 4 ? "Example Coder" : "Example Chat",
                Markdown = topic.Answer,
                ThoughtSummary = topic.Thought,
            });

            if (topic.Tool is not null)
            {
                items.Add(topic.Tool());
            }

            if (i % 6 == 5)
            {
                items.Add(new UsageItem
                {
                    Id = Next("u"),
                    At = at + TimeSpan.FromSeconds(24),
                    Usage = MockUsage.Turn(
                        9_000 + (i * 740),
                        900 + (i * 60),
                        6_400 + (i * 520),
                        0.09 + (i * 0.013),
                        1_400 + (i * 55),
                        1 + (i % 5)),
                });
            }
        }
    }

    private void BuildRecent(List<TimelineItem> items)
    {
        var t = Now - TimeSpan.FromMinutes(26);

        items.Add(new DayDividerItem { Id = Next("day"), At = t, Label = "14:06" });

        items.Add(new TurnItem
        {
            Id = Next("t"),
            At = t,
            Role = TurnRole.User,
            Author = "You",
            Node = NodeKind.Anchor,
            Markdown =
                "`tests/harness/test_adapter.py::test_session_authority_is_stable` has been failing since the "
                + "rename landed. I do **not** want to relax the contract to make it pass — figure out what actually "
                + "broke and show me the change before applying it.",
        });

        items.Add(new TurnItem
        {
            Id = Next("t"),
            At = t + TimeSpan.FromSeconds(6),
            Role = TurnRole.Assistant,
            Author = "Assistant",
            ModelLabel = "Example Chat",
            ThoughtSummary = "Mapping the rename across 6 files before touching anything",
            Markdown = AnalysisMarkdown,
        });

        items.Add(MockToolEvents.Search(
            "rg -n \"session_authority\" --type py",
            "17 matches in 6 files",
            "harness/example/adapter.py:88:        self.session_authority = authority\nharness/example/adapter.py:141:        if self.session_authority is None:\nharness/example/adapter.py:204:            authority=self.session_authority,\nharness/contracts/session.py:31:    session_authority: SessionAuthority | None = None\nharness/contracts/session.py:64:        return self.session_authority is not None\nharness/runtime/dispatch.py:52:    authority = contract.session_authority\nharness/runtime/dispatch.py:118:    if authority is None:\ntests/harness/test_adapter.py:141:    assert adapter.session_authority is not None\ntests/harness/test_session.py:22:    contract.session_authority = FakeAuthority()\ntests/harness/conftest.py:19:    return {\"session_authority\": FakeAuthority()}\ndocs/API.md:412:  `session_authority` — owner of the session id\n... 6 more"));

        items.Add(MockToolEvents.Read(
            "harness/example/adapter.py",
            "412 lines · lines 120–160 shown",
            AdapterSource,
            "python"));

        items.Add(MockToolEvents.Read(
            "harness/contracts/session.py",
            "96 lines · read fully",
            ContractSource,
            "python"));

        items.Add(new TurnItem
        {
            Id = Next("t"),
            At = t + TimeSpan.FromMinutes(2),
            Role = TurnRole.Assistant,
            Author = "Assistant",
            ModelLabel = "Example Chat",
            Markdown = FindingMarkdown,
        });

        items.Add(MockToolEvents.Shell(
            "uv run pytest tests/harness/test_adapter.py -q",
            "1 failed, 23 passed in 6.02s",
            "F.......................                                          [100%]\n"
            + "=================================== FAILURES ===================================\n"
            + "_____________________ test_session_authority_is_stable _________________________\n\n"
            + "    def test_session_authority_is_stable(adapter):\n"
            + "        adapter.connect()\n"
            + ">       assert adapter.session_authority is not None\n"
            + "E       AssertionError: assert None is not None\n\n"
            + "tests/harness/test_adapter.py:141: AssertionError\n"
            + "1 failed, 23 passed in 6.02s",
            ToolOutcome.Failed,
            6_020));

        items.Add(MockToolEvents.Native(
            "native.fs.watch",
            "harness/**/*.py",
            "watching 3 roots · 120ms coalescing",
            "{\n  \"watcher_id\": \"w_7f21\",\n  \"roots\": [\n    \"harness/example\",\n    \"harness/contracts\",\n    \"harness/runtime\"\n  ],\n  \"debounce_ms\": 120,\n  \"backend\": \"notify::RecommendedWatcher\",\n  \"host\": \"example-native-host 0.4.2\"\n}"));

        items.Add(new TurnItem
        {
            Id = Next("t"),
            At = t + TimeSpan.FromMinutes(4),
            Role = TurnRole.Assistant,
            Author = "Assistant",
            ModelLabel = "Example Chat",
            Markdown = NativeMarkdown,
        });

        items.Add(MockToolEvents.FailedConnector());

        items.Add(new NoticeItem
        {
            Id = Next("n"),
            At = t + TimeSpan.FromMinutes(5),
            Text = "Fell back to the cached harness catalogue from 13:04",
            Detail = "Exchange is a shared service — Navigator never blocks on it.",
        });

        items.Add(MockToolEvents.SettledApproval());

        items.Add(new DiffItem
        {
            Id = Next("d"),
            At = t + TimeSpan.FromMinutes(7),
            Path = "harness/contracts/session.py",
            Language = "python",
            Added = 6,
            Removed = 2,
            Node = NodeKind.Marked,
            Patch = ContractPatch,
        });

        items.Add(new ArtifactItem
        {
            Id = Next("a"),
            At = t + TimeSpan.FromMinutes(8),
            Title = "session-contract-rename.md",
            Kind = ArtifactKind.Document,
            Subtitle = "Change note · 4 sections · ready to attach to the PR",
            SizeLabel = "6.2 KB",
            Node = NodeKind.Marked,
            Tags = new[] { "change-note", "harness", "contract" },
            Preview =
                "# Session contract rename\n\n"
                + "`session_authority` becomes `authority_ref`. The old name stays as a deprecated\n"
                + "property for one release so downstream harnesses keep working.\n\n"
                + "## Why the test failed\n"
                + "The authority was resolved before the transport handshake completed …",
            PreviewLanguage = "markdown",
        });

        items.Add(new TurnItem
        {
            Id = Next("t"),
            At = t + TimeSpan.FromMinutes(9),
            Role = TurnRole.Assistant,
            Author = "Assistant",
            ModelLabel = "Example Chat",
            Markdown = ContractShapeMarkdown,
        });

        items.Add(new UsageItem
        {
            Id = Next("u"),
            At = t + TimeSpan.FromMinutes(9),
            Usage = MockUsage.Turn(46_820, 5_940, 38_400, 0.92, 2_310, 9),
        });

        items.Add(new NoticeItem
        {
            Id = Next("n"),
            At = t + TimeSpan.FromMinutes(11),
            Text = "Model switched to Example Chat · thinking enabled",
            Detail = "Previous turns in this session used Example Coder.",
        });

        // ---- live region ---------------------------------------------------------------------

        items.Add(new TurnItem
        {
            Id = Next("t"),
            At = Now - TimeSpan.FromMinutes(2),
            Role = TurnRole.User,
            Author = "You",
            Node = NodeKind.Anchor,
            Markdown = "Good. Go ahead and reproduce it end to end, then show me the fix as a diff.",
        });

        items.Add(new RunItem
        {
            Id = "live-run",
            At = Now - TimeSpan.FromMinutes(2),
            Node = NodeKind.Active,
        });

        items.Add(MockToolEvents.RunningTest());

        var approval = MockToolEvents.PendingApproval();
        approval.Node = NodeKind.Blocked;
        items.Add(approval);

        items.Add(new TurnItem
        {
            Id = "streaming-tail",
            At = Now,
            Role = TurnRole.Assistant,
            Author = "Assistant",
            ModelLabel = "Example Chat",
            IsStreaming = true,
            Markdown = string.Empty,
        });
    }

    /// <summary>
    /// Single pass that decides how each row draws the spine. Everything before the live run is
    /// settled hairline; the row immediately before it carries the rise; from the run onwards the
    /// spine is the full brand gradient.
    /// </summary>
    private static void AssignTrace(List<TimelineItem> items)
    {
        var liveIndex = -1;
        for (var i = 0; i < items.Count; i++)
        {
            if (items[i] is RunItem)
            {
                liveIndex = i;
                break;
            }
        }

        for (var i = 0; i < items.Count; i++)
        {
            var item = items[i];
            if (item is DayDividerItem)
            {
                item.Trace = TraceRole.None;
                continue;
            }

            if (liveIndex < 0)
            {
                item.Trace = TraceRole.Settled;
                continue;
            }

            item.Trace = i switch
            {
                _ when i < liveIndex - 1 => TraceRole.Settled,
                _ when i == liveIndex - 1 => TraceRole.Rise,
                _ => TraceRole.Live,
            };
        }

        // Tool rows inside settled history should not compete with the prose.
        foreach (var item in items)
        {
            if (item is ToolItem tool && tool.Node == NodeKind.None)
            {
                tool.Node = tool.Outcome switch
                {
                    ToolOutcome.Failed => NodeKind.Failed,
                    ToolOutcome.Running => NodeKind.Active,
                    _ => NodeKind.None,
                };
            }
        }
    }

    private string Next(string prefix) =>
        prefix + "-" + (++_seq).ToString(CultureInfo.InvariantCulture);

    // -----------------------------------------------------------------------------------------
    // Content fixtures
    // -----------------------------------------------------------------------------------------

    private sealed record Topic(string Ask, string Thought, string Answer, Func<TimelineItem>? Tool);

    private static readonly Topic[] HistoryTopics = BuildTopics();

    private static Topic[] BuildTopics()
    {
        var list = new List<Topic>();

        var seeds = new (string Ask, string Thought, string Answer)[]
        {
            ("Where does Navigator decide which harness to load?",
                "Tracing the resolver from startup",
                "The decision happens in `PlatformResolver.resolve_harness()`, not in either UI surface.\n\nThe browser WebUI and native client only pass a **workspace descriptor**; the resolver then walks the configured sources in order.\n\nThe first hit wins, and the decision is recorded in the session so a later reconnect is deterministic."),
            ("Why is the first token slower on workspace models than hosted ones?",
                "Comparing cold-start paths",
                "Because hosted providers keep the prefix cache warm for you and the workspace pool does not.\n\nOn `demo-workspace` the first request after an idle period pays for:\n\n- KV cache allocation on the target shard\n- Tokenizer load (about 240 ms on the Demo GPU nodes)\n- Prefix re-computation of the system block\n\nAfter the first turn the numbers converge. If it matters, pin a warmer on the pool."),
            ("Does the native host ever run untrusted code?",
                "Checking the capability boundary",
                "No. `example-native-host` exposes a fixed capability list and never evaluates model output as code.\n\nShell execution is a *capability*, not an escape hatch: the command is built by the harness, the host validates it against the session's allowed roots, and anything outside those roots turns into an approval request rather than a failure."),
            ("Summarise the difference between a session and a run.",
                "Reading the contract docs",
                "A **session** is the conversation and its authority. A **run** is one attempt by an agent to accomplish something inside that session.\n\n| | Session | Run |\n| --- | --- | --- |\n| Lifetime | Until closed | Minutes |\n| Owns | History, authority, model choice | Steps, tool calls, usage |\n| Cancellable | No | Yes |\n\nA session can contain many runs; a run never outlives its session."),
            ("How large can a tool response be before we truncate it?",
                "Checking transport limits",
                "The transport accepts 8 MB, but the harness truncates tool responses at **256 KB** before they reach the model, keeping the head and the tail.\n\nThe full response is still written to the run log, so the UI can show everything even though the model only ever saw the trimmed version. That distinction matters when you are debugging a disagreement between what you see and what the model reasoned about."),
            ("What happens to an in-flight run if the desktop client quits?",
                "Following the reconnect path",
                "It keeps running. Runs live on the session authority, not in the client.\n\nOn restart Navigator re-attaches to any run still in `running` state and replays the step log, which is why the trace can be rebuilt exactly as it was. Only *local* tool calls that need this device are paused until the client is back."),
            ("Why do we surface where a tool ran?",
                "Recalling the design rationale",
                "Because \"the model read a file\" and \"something on your laptop read a file\" are different events, and users are entitled to know which one happened.\n\nEvery tool card carries its origin: native host, workspace, or external connector. It costs one line and removes an entire category of anxious guessing."),
            ("Is there a reason usage is shown per turn rather than per session?",
                "Checking the product decision log",
                "Both are shown, but per-turn is the one that changes behaviour.\n\nSession totals tell you what already happened. Per-turn cost tells you whether to keep going with this model on this problem — a decision people make several times an hour. Putting it at the end of the turn means it is there exactly when the decision is made."),
            ("Do approvals block the whole session or just the run?",
                "Checking the dispatcher",
                "Just the run. Other runs in the same session continue.\n\nThe blocked run parks in `awaiting_approval` and holds its step trace, so answering it resumes from exactly where it stopped rather than restarting the phase."),
            ("What is the cheapest way to re-run an eval over 2 000 transcripts?",
                "Estimating cost across tiers",
                "Put it on the workspace pool with `Example Local 32B` and batch it.\n\nAt 2 000 transcripts averaging 1 800 input tokens, a hosted frontier model runs roughly **$54**. The same job on the Demo GPU Pool is pool time you have already paid for, and the accuracy gap on classification-style evals has been inside noise for the last three runs."),
            ("Can I keep a session entirely on-device?",
                "Checking local model constraints",
                "Yes, if you pick a local model and accept the capability loss.\n\nOn-device sessions cannot use external connectors, and tool calls are limited to the roots you granted. In exchange nothing leaves the machine — which is the whole point of the redaction workflow."),
            ("Why is the composer a single input instead of a mode switcher?",
                "Recalling the interaction decision",
                "Because modes make the user classify their intent before they have expressed it.\n\nThe composer stays one input; what changes is the *context strip* above it — model, agent, allowed roots. Capability appears when it is relevant instead of being permanently on display as a menu of features."),
        };

        // Repeat the seed set with rotating tool attachments so the generated history has real
        // variety across roughly 100 rows without being visibly cyclic.
        for (var round = 0; round < 4; round++)
        {
            for (var i = 0; i < seeds.Length; i++)
            {
                var seed = seeds[(i + round) % seeds.Length];
                Func<TimelineItem>? tool = ((i + round) % 4) switch
                {
                    0 => () => MockToolEvents.Read(
                        "harness/runtime/dispatch.py",
                        "184 lines · lines 40–72 shown",
                        DispatchSource,
                        "python"),
                    1 => () => MockToolEvents.Search(
                        "rg -n \"awaiting_approval\" --type py",
                        "5 matches in 3 files",
                        "harness/runtime/dispatch.py:118:        state = \"awaiting_approval\"\nharness/runtime/dispatch.py:140:    if state == \"awaiting_approval\":\nharness/contracts/run.py:44:    AWAITING_APPROVAL = \"awaiting_approval\"\ntests/harness/test_approval.py:31:    assert run.state == \"awaiting_approval\"\ntests/harness/test_approval.py:58:    assert run.state != \"awaiting_approval\""),
                    2 => () => MockToolEvents.Native(
                        "native.sysinfo",
                        "gpu",
                        "1 device · Demo GPU · 24 GB",
                        "{\n  \"devices\": [\n    {\n      \"name\": \"Demo GPU\",\n      \"vram_total_mb\": 24564,\n      \"vram_free_mb\": 19180,\n      \"driver\": \"demo-driver\",\n      \"compute\": \"8.9\"\n    }\n  ],\n  \"npu\": null\n}"),
                    _ => null,
                };

                list.Add(new Topic(seed.Ask, seed.Thought, seed.Answer, tool));
            }
        }

        return list.ToArray();
    }

    private const string AnalysisMarkdown =
        "Before I change anything: the rename touched three layers, and only one of them is actually wrong.\n\n"
        + "## What the contract says\n\n"
        + "`SessionContract` is supposed to guarantee that once `bind()` returns, the session has an "
        + "authority. The test asserts exactly that guarantee, so if the test is failing then either the "
        + "guarantee is broken or `bind()` is returning too early.\n\n"
        + "## Where the name appears\n\n"
        + "| Layer | File | Occurrences | Correct after rename |\n"
        + "| --- | --- | --- | --- |\n"
        + "| Adapter | `harness/example/adapter.py` | 3 | partially |\n"
        + "| Contract | `harness/contracts/session.py` | 2 | yes |\n"
        + "| Dispatcher | `harness/runtime/dispatch.py` | 2 | yes |\n"
        + "| Tests | `tests/harness/*.py` | 4 | yes |\n"
        + "| Docs | `docs/API.md` | 6 | not yet |\n\n"
        + "The adapter is the odd one out — it renamed the *attribute* but kept the original "
        + "resolution order, and that order is the actual bug.\n\n"
        + "> The rename did not break the test. It exposed a race that was always there and happened to "
        + "be masked by the old attribute being written twice.\n\n"
        + "Next I want to read the adapter around the handshake and the contract's `bind()`.";

    private const string FindingMarkdown =
        "Found it, and it is not where the rename happened.\n\n"
        + "`ExampleAdapter.connect()` resolves the authority **before** awaiting the transport "
        + "handshake:\n\n"
        + "```python\n"
        + "def connect(self) -> None:\n"
        + "    # authority is read from a header that only exists after the handshake\n"
        + "    self.authority_ref = self._transport.header(\"x-cyrene-authority\")\n"
        + "    self._transport.handshake()          # <-- too late\n"
        + "    self._contract.bind(self.authority_ref)\n"
        + "```\n\n"
        + "On a warm connection the header is already cached, so the value is present and the test "
        + "passes. On a cold connection — which is what CI always has — `header()` returns `None`, "
        + "`bind()` accepts it, and the assertion fires three lines later.\n\n"
        + "The old code got away with it because `session_authority` was assigned a second time inside "
        + "`_on_ready()`. The rename dropped that second assignment, so the race stopped being masked.\n\n"
        + "Two consequences worth stating plainly:\n\n"
        + "- The contract is currently **not** guaranteeing what it claims. `bind(None)` should never "
        + "have been accepted.\n"
        + "- Any harness that connects cold and reads the authority immediately has the same latent bug, "
        + "not just Example Coder.";

    private const string NativeMarkdown =
        "I also checked the native side, because the same header is read by the Rust host when it sets "
        + "up file watching for the session:\n\n"
        + "```rust\n"
        + "pub fn bind_session(&self, hdr: &Headers) -> Result<SessionScope, HostError> {\n"
        + "    // Reject early rather than carrying an unauthenticated scope forward.\n"
        + "    let authority = hdr\n"
        + "        .get(\"x-cyrene-authority\")\n"
        + "        .ok_or(HostError::MissingAuthority)?;\n"
        + "\n"
        + "    let scope = SessionScope::new(authority)?;\n"
        + "    self.watchers.insert(scope.id(), Watcher::debounced(Duration::from_millis(120)));\n"
        + "    Ok(scope)\n"
        + "}\n"
        + "```\n\n"
        + "The Rust host already does the right thing — it refuses to construct a scope without an "
        + "authority. So the Python contract is the outlier, and making it match the host is the "
        + "conservative fix rather than a new invention.";

    private const string ContractShapeMarkdown =
        "Here is the shape I want to apply. It keeps the contract strict and adds a deprecation path so "
        + "downstream harnesses do not break in the same release.\n\n"
        + "```python\n"
        + "class SessionContract:\n"
        + "    authority_ref: AuthorityRef | None = None\n"
        + "\n"
        + "    def bind(self, authority: AuthorityRef) -> None:\n"
        + "        if authority is None:\n"
        + "            raise ContractViolation(\"bind() requires a resolved authority\")\n"
        + "        self.authority_ref = authority\n"
        + "\n"
        + "    @property\n"
        + "    def session_authority(self) -> AuthorityRef | None:\n"
        + "        warnings.warn(\n"
        + "            \"session_authority is deprecated; use authority_ref\",\n"
        + "            DeprecationWarning,\n"
        + "            stacklevel=2,\n"
        + "        )\n"
        + "        return self.authority_ref\n"
        + "```\n\n"
        + "And the adapter simply moves one line:\n\n"
        + "```json\n"
        + "{\n"
        + "  \"change\": \"reorder\",\n"
        + "  \"file\": \"harness/example/adapter.py\",\n"
        + "  \"before\": [\"read_header\", \"handshake\", \"bind\"],\n"
        + "  \"after\": [\"handshake\", \"read_header\", \"bind\"],\n"
        + "  \"tests_unblocked\": [\"test_session_authority_is_stable\"],\n"
        + "  \"risk\": \"low\",\n"
        + "  \"reversible\": true\n"
        + "}\n"
        + "```\n\n"
        + "Applying this needs one migration on the workspace database, which is why the next step will "
        + "ask you first.";

    private const string AdapterSource =
        "class ExampleAdapter(HarnessAdapter):\n"
        + "    \"\"\"Adapter for the Example harness transport.\"\"\"\n"
        + "\n"
        + "    def __init__(self, transport: Transport, contract: SessionContract) -> None:\n"
        + "        self._transport = transport\n"
        + "        self._contract = contract\n"
        + "        self.authority_ref: AuthorityRef | None = None\n"
        + "\n"
        + "    def connect(self) -> None:\n"
        + "        self.authority_ref = self._transport.header(\"x-cyrene-authority\")\n"
        + "        self._transport.handshake()\n"
        + "        self._contract.bind(self.authority_ref)\n"
        + "\n"
        + "    def _on_ready(self, frame: ReadyFrame) -> None:\n"
        + "        # NOTE: the second assignment that used to hide the race was removed here.\n"
        + "        self._emit(\"ready\", frame.session_id)\n";

    private const string ContractSource =
        "@dataclass(slots=True)\n"
        + "class SessionContract:\n"
        + "    \"\"\"Invariant: after bind() the session has a resolved authority.\"\"\"\n"
        + "\n"
        + "    session_id: str\n"
        + "    authority_ref: AuthorityRef | None = None\n"
        + "\n"
        + "    def bind(self, authority: AuthorityRef | None) -> None:\n"
        + "        self.authority_ref = authority\n"
        + "\n"
        + "    @property\n"
        + "    def is_bound(self) -> bool:\n"
        + "        return self.authority_ref is not None\n";

    private const string DispatchSource =
        "async def dispatch(run: Run, contract: SessionContract) -> RunResult:\n"
        + "    authority = contract.authority_ref\n"
        + "    if authority is None:\n"
        + "        raise ContractViolation(\"dispatch requires a bound session\")\n"
        + "\n"
        + "    for step in run.plan:\n"
        + "        if step.needs_approval and not run.approved(step):\n"
        + "            run.state = \"awaiting_approval\"\n"
        + "            await run.park()\n"
        + "            continue\n"
        + "\n"
        + "        result = await _execute(step, authority=authority)\n"
        + "        run.record(step, result)\n"
        + "\n"
        + "    return run.finish()\n";

    private const string ContractPatch =
        "--- a/harness/contracts/session.py\n"
        + "+++ b/harness/contracts/session.py\n"
        + "@@ -25,10 +25,14 @@ class SessionContract:\n"
        + "     session_id: str\n"
        + "     authority_ref: AuthorityRef | None = None\n"
        + " \n"
        + "-    def bind(self, authority: AuthorityRef | None) -> None:\n"
        + "-        self.authority_ref = authority\n"
        + "+    def bind(self, authority: AuthorityRef) -> None:\n"
        + "+        if authority is None:\n"
        + "+            raise ContractViolation(\"bind() requires a resolved authority\")\n"
        + "+        self.authority_ref = authority\n"
        + " \n"
        + "     @property\n"
        + "     def is_bound(self) -> bool:\n"
        + "         return self.authority_ref is not None\n"
        + "+\n"
        + "+    @property\n"
        + "+    def session_authority(self) -> AuthorityRef | None:\n"
        + "+        return self.authority_ref\n";
}
