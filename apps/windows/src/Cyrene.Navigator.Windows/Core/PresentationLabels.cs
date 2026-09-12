// Core/PresentationLabels.cs
//
// Client presentation vocabulary / 客户端展示词汇。
//
// These strings describe how the client groups and labels things. They are not service data:
// the same labels apply whether the underlying source is the preview fixture or the real API.

namespace Cyrene.Navigator.Windows.Core;

public static class PresentationLabels
{
    public static string TierLabel(ModelTier tier) => tier switch
    {
        ModelTier.Hosted => "Hosted",
        ModelTier.Workspace => "Workspace",
        _ => "On this device",
    };

    /// <summary>Explains, in one line, what choosing this tier means operationally.</summary>
    public static string TierNote(ModelTier tier) => tier switch
    {
        ModelTier.Hosted => "Billed to the workspace account. Prompts leave your network.",
        ModelTier.Workspace => "Served from your own GPU pool. Stays inside the workspace.",
        _ => "Runs on this machine. Works with no network.",
    };

    /// <summary>Human label for a tool family. Short enough to sit in a tracked micro-label.</summary>
    public static string ToolLabel(ToolKind kind) => kind switch
    {
        ToolKind.ReadFile => "READ",
        ToolKind.EditFile => "EDIT",
        ToolKind.Search => "SEARCH",
        ToolKind.Shell => "SHELL",
        ToolKind.NativeTool => "NATIVE",
        ToolKind.Connector => "CONNECTOR",
        ToolKind.Http => "HTTP",
        ToolKind.Test => "TEST",
        _ => "BROWSER",
    };
}
