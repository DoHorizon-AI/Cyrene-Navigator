// Core/Api/ApiConversationService.cs
//
// Real Navigator API conversation adapter / 真实 Navigator API 对话适配器。
//
// Sessions and the selected session's committed events come from the Navigator persistence
// service. The adapter is a bounded snapshot: it fetches on construction and whenever a
// session is opened, and it reports a typed connection state instead of guessing.

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Api;

public sealed class ApiConversationService : IConversationService
{
    private readonly NavigatorApiClient? _client;
    private readonly string _notConfiguredDetail;
    private List<SessionSummary> _sessions = new();
    private NavigatorProjection _projection = new();
    private string? _openSessionId;

    public ApiConversationService(NavigatorApiClient? client, string notConfiguredDetail)
    {
        _client = client;
        _notConfiguredDetail = notConfiguredDetail;
        if (client is null)
        {
            IsConnected = false;
            ConnectionDetail = notConfiguredDetail;
            return;
        }

        try
        {
            var now = DateTimeOffset.Now;
            var records = client.ListSessions();
            var summaries = new List<SessionSummary>();
            foreach (var record in records)
            {
                summaries.Add(NavigatorEventProjection.Summarize(record, now));
            }

            _sessions = summaries;
            IsConnected = true;
            ConnectionDetail = "Connected to " + client.Options.BaseUrl
                + " · workspace " + client.Options.WorkspaceId;
        }
        catch (NavigatorApiError error)
        {
            IsConnected = false;
            ConnectionDetail = error.Code + ": " + error.Message;
        }
    }

    public bool IsConnected { get; private set; }

    public string ConnectionDetail { get; private set; }

    /// <summary>
    /// Submitting a turn requires the Harness write path, which is not connected to this client;
    /// the prototype never claims a delivery it cannot make.
    /// </summary>
    public bool CanSubmit => false;

    /// <summary>Latest projection of the open session; also read by the run and UI-data adapters.</summary>
    public NavigatorProjection Projection => _projection;

    public IReadOnlyList<SessionSummary> Sessions() => _sessions;

    public void OpenSession(string sessionId)
    {
        _openSessionId = sessionId;
        if (_client is null)
        {
            _projection = new NavigatorProjection();
            return;
        }

        try
        {
            var page = _client.ReadEvents(sessionId);
            _projection = NavigatorEventProjection.Project(page.Events);
        }
        catch (NavigatorApiError error)
        {
            _projection = new NavigatorProjection();
            ConnectionDetail = error.Code + ": " + error.Message;
        }
    }

    public IReadOnlyList<TimelineItem> Timeline() => _projection.Timeline;

    /// <summary>
    /// The streaming tail is the interactive submission affordance. This client has no write
    /// path, so the tail is always empty rather than a scripted reply.
    /// </summary>
    public StreamingScript StreamingTail() => new(string.Empty);

    /// <summary>Session id currently projected, for diagnostics.</summary>
    public string? OpenSessionId => _openSessionId;
}
