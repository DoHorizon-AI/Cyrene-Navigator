// Core/Ports/IAgentState.cs
//
// Product-facing run-state port / 产品侧运行状态端口。
//
// The Windows UI owns timers and rendering. A preview fixture or the real Navigator API
// adapter supplies the run. Control actions (stop, decide) must either reach the owning
// service or fail with a typed error — they never change state locally without authority.

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core;

public interface IAgentState
{
    AgentRun Run { get; }

    /// <summary>Pending approval for one run, or null when that run has none.</summary>
    ApprovalItem? PendingApproval(string runId);

    event Action? Changed;

    bool Tick(TimeSpan delta);

    void Restart();

    void Stop();

    /// <summary>Records the user's decision for one pending approval.</summary>
    void Decide(string runId, string decision);

    IReadOnlyList<AgentRun> BackgroundRuns();
}
