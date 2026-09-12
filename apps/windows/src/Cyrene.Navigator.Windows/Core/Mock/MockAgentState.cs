// Core/Mock/MockAgentState.cs
//
// Mock agent run state machine / Agent 运行状态机（mock）。
//
// The run advances on <see cref="Tick"/> so the *UI* owns the clock (a DispatcherTimer) and this
// file stays free of any UI dependency. Replacing this with the real Harness run stream means
// implementing the same three members: Steps, State, and a change notification.
//
// 设计要点：步骤分两层（阶段 → 具体调用）。只有"当前阶段"值得完整展开，已完成的阶段会自动
// 收起并降低视觉权重 —— 这样长任务不会变成一片终端日志。

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Mock;

public sealed class MockAgentState : IAgentState
{
    private const double SecondsPerSubStep = 1.35;

    private double _accumulated;

    public MockAgentState()
    {
        Run = BuildRun();
    }

    public AgentRun Run { get; private set; }

    /// <summary>Fixture approval attached to the awaiting background run.</summary>
    private readonly ApprovalItem _pendingApproval = new()
    {
        Id = "approval-run_01JQ8Y2K9P4T",
        At = new DateTimeOffset(2026, 9, 6, 14, 28, 0, TimeSpan.FromHours(8)),
        Title = "Allow the agent to continue?",
        Rationale = "The next step requires a capability that is outside the run's automatic approval policy.",
        Kind = ToolKind.Shell,
        Command = "pnpm test",
        CommandLanguage = "bash",
        Risk = ApprovalRisk.Elevated,
        Facts = new[]
        {
            ("scope", "Example Product"),
            ("origin", "native host"),
            ("effect", "runs the repository test command"),
        },
        Trace = TraceRole.Live,
        Node = NodeKind.Blocked,
    };

    /// <summary>Raised after every state transition worth redrawing.</summary>
    public event Action? Changed;

    /// <summary>
    /// Advances the simulation. Returns true when something visible changed, so callers can
    /// skip redraws on ticks that only moved the elapsed clock.
    /// </summary>
    public bool Tick(TimeSpan delta)
    {
        if (Run.State != RunState.Running)
        {
            return false;
        }

        Run.Elapsed += delta;
        _accumulated += delta.TotalSeconds;

        var current = CurrentStep();
        if (current is not null)
        {
            current.Elapsed += delta;
        }

        if (_accumulated < SecondsPerSubStep)
        {
            return false;
        }

        _accumulated = 0;
        AdvanceOne();
        Changed?.Invoke();
        return true;
    }

    /// <summary>Restarts the demo run from the first step.</summary>
    public void Restart()
    {
        Run = BuildRun();
        _accumulated = 0;
        Changed?.Invoke();
    }

    public void Stop()
    {
        Run.State = RunState.Cancelled;
        foreach (var step in Run.Steps)
        {
            if (step.State == StepState.Running)
            {
                step.State = StepState.Skipped;
            }

            foreach (var child in step.Children)
            {
                if (child.State == StepState.Running)
                {
                    child.State = StepState.Skipped;
                }
            }
        }

        Changed?.Invoke();
    }

    /// <summary>Currently running leaf-owning phase, or null when the run is between phases.</summary>
    public AgentStep? CurrentStep()
    {
        foreach (var step in Run.Steps)
        {
            if (step.State == StepState.Running)
            {
                return step;
            }
        }

        return null;
    }

    /// <summary>The single line that answers "what is happening right now".</summary>
    public string NowLine()
    {
        var step = CurrentStep();
        if (step is null)
        {
            return Run.State switch
            {
                RunState.Done => "Finished",
                RunState.Failed => "Stopped on an error",
                RunState.Cancelled => "Cancelled",
                _ => "Starting",
            };
        }

        foreach (var child in step.Children)
        {
            if (child.State == StepState.Running)
            {
                return child.Title;
            }
        }

        return step.Title;
    }

    private void AdvanceOne()
    {
        var step = CurrentStep();
        if (step is null)
        {
            // Start the first pending phase.
            foreach (var candidate in Run.Steps)
            {
                if (candidate.State == StepState.Pending)
                {
                    candidate.State = StepState.Running;
                    if (candidate.Children.Count > 0)
                    {
                        candidate.Children[0].State = StepState.Running;
                    }

                    return;
                }
            }

            Run.State = RunState.Done;
            return;
        }

        // Complete the running child and start the next one.
        for (var i = 0; i < step.Children.Count; i++)
        {
            if (step.Children[i].State != StepState.Running)
            {
                continue;
            }

            step.Children[i].State = step.Children[i].Title.Contains("failed", StringComparison.OrdinalIgnoreCase)
                ? StepState.Failed
                : StepState.Done;

            if (i + 1 < step.Children.Count)
            {
                step.Children[i + 1].State = StepState.Running;
                return;
            }

            break;
        }

        step.State = StepState.Done;

        foreach (var candidate in Run.Steps)
        {
            if (candidate.State == StepState.Pending)
            {
                candidate.State = StepState.Running;
                if (candidate.Children.Count > 0)
                {
                    candidate.Children[0].State = StepState.Running;
                }

                return;
            }
        }

        Run.State = RunState.Done;
    }

    // -----------------------------------------------------------------------------------------
    // Fixture
    // -----------------------------------------------------------------------------------------

    private static AgentRun BuildRun()
    {
        var run = new AgentRun
        {
            Id = "run_01JQ8Z7X4M2N",
            AgentName = "Example Agent",
            Goal = "Make tests/harness/test_adapter.py pass without loosening the session contract",
            ModelLabel = "Example Chat",
            State = RunState.Running,
            Elapsed = TimeSpan.FromSeconds(0),
            Usage = MockUsage.Turn(18_240, 3_120, 14_880, 0.51, 1_920, 11),
        };

        run.Steps.Add(Phase("Read the failing contract", "Two assertions disagree about who owns the session id",
            StepState.Done));

        run.Steps.Add(Phase("Search repository", "6 files reference the old name", StepState.Done,
            Leaf("rg -n \"session_authority\" --type py", "17 matches in 6 files", ToolKind.Search, StepState.Done),
            Leaf("rg -n \"authority_ref\" --type py", "no matches — the new name is unused", ToolKind.Search, StepState.Done),
            Leaf("code.symbols harness/example/adapter.py", "24 symbols", ToolKind.NativeTool, StepState.Done)));

        run.Steps.Add(Phase("Read the call sites", "Adapter, contract and test", StepState.Done,
            Leaf("harness/example/adapter.py", "412 lines", ToolKind.ReadFile, StepState.Done),
            Leaf("harness/contracts/session.py", "96 lines", ToolKind.ReadFile, StepState.Done),
            Leaf("tests/harness/test_adapter.py", "188 lines", ToolKind.ReadFile, StepState.Done)));

        run.Steps.Add(Phase("Reproduce the failure", "Confirmed: assertion at line 141", StepState.Running,
            Leaf("uv run pytest tests/harness/test_adapter.py -q", "1 failed, 23 passed in 6.02s", ToolKind.Test, StepState.Running),
            Leaf("parse pytest report", "AssertionError on session_authority", ToolKind.NativeTool, StepState.Pending)));

        run.Steps.Add(Phase("Apply the rename", "Adapter plus contract, keeping a deprecation alias", StepState.Pending,
            Leaf("harness/example/adapter.py", "+34 −12", ToolKind.EditFile, StepState.Pending),
            Leaf("harness/contracts/session.py", "+6 −2", ToolKind.EditFile, StepState.Pending)));

        run.Steps.Add(Phase("Re-run the suite", "214 tests", StepState.Pending,
            Leaf("uv run pytest tests/harness -q", "waiting", ToolKind.Test, StepState.Pending)));

        run.Steps.Add(Phase("Lint and type-check", "ruff, then mypy", StepState.Pending,
            Leaf("uv run ruff check harness", "waiting", ToolKind.Shell, StepState.Pending),
            Leaf("uv run mypy harness", "waiting", ToolKind.Shell, StepState.Pending)));

        run.Steps.Add(Phase("Summarise the change", "Diff summary and follow-ups", StepState.Pending));

        return run;
    }

    private static AgentStep Phase(string title, string detail, StepState state, params AgentStep[] children)
    {
        var step = new AgentStep
        {
            Id = Guid.NewGuid().ToString("N")[..8],
            Title = title,
            Detail = detail,
            State = state,
            Elapsed = state == StepState.Done ? TimeSpan.FromSeconds(Random.Shared.Next(2, 19)) : TimeSpan.Zero,
        };

        foreach (var child in children)
        {
            step.Children.Add(child);
        }

        return step;
    }

    private static AgentStep Leaf(string title, string detail, ToolKind tool, StepState state) => new()
    {
        Id = Guid.NewGuid().ToString("N")[..8],
        Title = title,
        Detail = detail,
        Tool = tool,
        State = state,
        Elapsed = state == StepState.Done ? TimeSpan.FromMilliseconds(Random.Shared.Next(40, 8_400)) : TimeSpan.Zero,
    };

    // -----------------------------------------------------------------------------------------
    // Other runs, for the Activity page
    // -----------------------------------------------------------------------------------------

    /// <summary>Background runs shown alongside the active one on the Activity page.</summary>
    public static IReadOnlyList<AgentRun> Background()
    {
        var awaiting = new AgentRun
        {
            Id = "run_01JQ8Y2K9P4T",
            AgentName = "Migration Agent",
            Goal = "Apply the pending alembic revision to demo-workspace",
            ModelLabel = "Example Coder",
            State = RunState.AwaitingApproval,
            Elapsed = TimeSpan.FromMinutes(4) + TimeSpan.FromSeconds(12),
            Usage = MockUsage.Turn(6_120, 940, 4_100, 0.03, 1_120, 4),
        };
        awaiting.Steps.Add(Phase("Inspect revision history", "1 revision pending", StepState.Done));
        awaiting.Steps.Add(Phase("Plan the migration", "2 tables, 1 index", StepState.Done));
        awaiting.Steps.Add(Phase("Waiting for your approval", "Writes to a shared workspace resource", StepState.Running));
        awaiting.Steps.Add(Phase("Apply and verify", "Blocked", StepState.Pending));

        var failed = new AgentRun
        {
            Id = "run_01JQ8X0M3B7Q",
            AgentName = "Catalog Sync",
            Goal = "Refresh the harness catalogue from Exchange",
            ModelLabel = "Example Local 32B",
            State = RunState.Failed,
            Elapsed = TimeSpan.FromMinutes(1) + TimeSpan.FromSeconds(48),
            Usage = MockUsage.Turn(2_040, 310, 0, 0.00, 14_206, 3),
        };
        failed.Steps.Add(Phase("Resolve endpoint", "exchange.example.invalid", StepState.Done));
        failed.Steps.Add(Phase("Fetch catalogue", "503 after 3 retries — shard demo-shard-1 draining", StepState.Failed));
        failed.Steps.Add(Phase("Fall back to cache", "Skipped", StepState.Skipped));

        var done = new AgentRun
        {
            Id = "run_01JQ8W4H1C2D",
            AgentName = "Docs Agent",
            Goal = "Rewrite docs/API.md session section for the new contract",
            ModelLabel = "Example Analyst",
            State = RunState.Done,
            Elapsed = TimeSpan.FromMinutes(11) + TimeSpan.FromSeconds(3),
            Usage = MockUsage.Turn(88_400, 6_210, 74_000, 0.42, 2_640, 19),
        };
        done.Steps.Add(Phase("Read the current docs", "1 file, 1 240 lines", StepState.Done));
        done.Steps.Add(Phase("Draft the replacement", "3 sections", StepState.Done));
        done.Steps.Add(Phase("Produce the artifact", "docs/API.session.md", StepState.Done));

        return new[] { awaiting, failed, done };
    }

    public IReadOnlyList<AgentRun> BackgroundRuns() => Background();

    /// <summary>Only the fixture awaiting run carries an approval.</summary>
    public ApprovalItem? PendingApproval(string runId) =>
        _pendingApproval.Decision is null && runId == "run_01JQ8Y2K9P4T" ? _pendingApproval : null;

    public void Decide(string runId, string decision)
    {
        if (runId != "run_01JQ8Y2K9P4T")
        {
            return;
        }

        _pendingApproval.Decision = decision;
        Changed?.Invoke();
    }
}
