// Core/Api/ApiAgentState.cs
//
// Run state projected from the Navigator API / 由 Navigator API 投影的运行状态。
//
// The run, its steps, and any pending approval are read from the committed event log through the
// conversation adapter. Control actions are not connected to an owning service yet, so they fail
// with a typed error the UI can show — they never fake a local state change.

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Api;

public sealed class ApiAgentState : IAgentState
{
    private readonly ApiConversationService _source;

    public ApiAgentState(ApiConversationService source)
    {
        _source = source;
    }

    public AgentRun Run => _source.Projection.Run;

    /// <summary>The projected session has at most one pending approval, on its own run.</summary>
    public ApprovalItem? PendingApproval(string runId)
    {
        var approval = _source.Projection.PendingApproval;
        return approval is not null && Run.Id == runId ? approval : null;
    }

    public event Action? Changed;

    /// <summary>
    /// The projection is a committed snapshot; nothing advances between reads, so a tick has
    /// nothing to advance and reports no visible change. Live tailing needs a control route.
    /// </summary>
    public bool Tick(TimeSpan delta)
    {
        _ = delta;
        _ = Changed;
        return false;
    }

    public void Restart() =>
        throw NavigatorApiError.NotConnected(
            "Starting a run",
            "the Harness control route is not available to this client; create or resume the session through the Harness connection host.");

    public void Stop() =>
        throw NavigatorApiError.NotConnected(
            "Cancelling a run",
            "the Harness control route is not available to this client.");

    public void Decide(string runId, string decision)
    {
        _ = runId;
        _ = decision;
        throw NavigatorApiError.NotConnected(
            "Recording an approval decision",
            "the Harness control route is not available to this client.");
    }

    /// <summary>Only one session is projected, so there are no background runs to report.</summary>
    public IReadOnlyList<AgentRun> BackgroundRuns() => Array.Empty<AgentRun>();
}
