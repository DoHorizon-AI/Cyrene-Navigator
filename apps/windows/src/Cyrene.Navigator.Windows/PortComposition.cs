// PortComposition.cs
//
// Composition root for the native client / 原生客户端组合根。
//
// This is the only place that chooses between the real Navigator API adapters and the preview
// fixtures, and it is the only place allowed to reference Core/Mock. Release builds do not
// compile the fixtures at all (see the csproj), so Release can only ever build the API path.

using System;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Core.Api;

namespace Cyrene.Navigator.Windows;

/// <summary>The three ports every view consumes. | 视图消费的三个端口。</summary>
public sealed class Ports
{
    public Ports(IConversationService conversation, IAgentState agent, INavigatorUiData uiData)
    {
        Conversation = conversation;
        Agent = agent;
        UiData = uiData;
    }

    public IConversationService Conversation { get; }

    public IAgentState Agent { get; }

    public INavigatorUiData UiData { get; }
}

public static class PortComposition
{
    /// <summary>
    /// Explicit preview switch. Only honoured in Debug builds; a Release binary ignores it.
    /// </summary>
    public const string PreviewVariable = "CYRENE_NAVIGATOR_UI_PREVIEW";

    public static Ports Create()
    {
#if DEBUG
        if (string.Equals(
            Environment.GetEnvironmentVariable(PreviewVariable),
            "mock",
            StringComparison.OrdinalIgnoreCase))
        {
            return Preview();
        }
#endif
        return Api();
    }

    /// <summary>Real adapters over the Navigator API; a missing configuration is reported, not hidden.</summary>
    private static Ports Api()
    {
        var options = NavigatorApiOptions.TryFromEnvironment(out var detail);
        NavigatorApiClient? client = options is null ? null : new NavigatorApiClient(options);
        var conversation = new ApiConversationService(client, detail);
        return new Ports(
            conversation,
            new ApiAgentState(conversation),
            new ApiUiData(conversation));
    }

#if DEBUG
    private static Ports Preview()
    {
        return new Ports(
            new Core.Mock.MockConversationService(),
            new Core.Mock.MockAgentState(),
            new Core.Mock.MockUiData());
    }
#endif
}
