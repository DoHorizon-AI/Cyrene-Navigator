// Core/Ports/IConversationService.cs
//
// Product-facing conversation port / 产品侧对话端口。
//
// Native UI consumes this contract; preview fixtures and the real Navigator API adapter live
// behind it. The connection flags are part of the contract because the UI must be able to say
// "not connected" instead of presenting fixture data as fact.

using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core;

public interface IConversationService
{
    /// <summary>True only when a real Navigator API responded; preview fixtures report false.</summary>
    bool IsConnected { get; }

    /// <summary>Stable, secret-free description of the connection state for the UI.</summary>
    string ConnectionDetail { get; }

    /// <summary>True only when this client can actually deliver a submitted turn.</summary>
    bool CanSubmit { get; }

    IReadOnlyList<SessionSummary> Sessions();

    /// <summary>Selects the session whose timeline and streaming tail are exposed.</summary>
    void OpenSession(string sessionId);

    IReadOnlyList<TimelineItem> Timeline();

    StreamingScript StreamingTail();
}
