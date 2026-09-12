// Core/Ports/INavigatorUiData.cs
//
// Product-facing presentation data port / 产品侧展示数据端口。
//
// Views and controls consume this contract instead of importing a fixture or a transport
// adapter. Metrics and resource sections are service data: an empty list means "nothing was
// reported" and the view says so.

using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core;

public interface INavigatorUiData
{
    IReadOnlyList<ModelDescriptor> Models { get; }

    ModelDescriptor DefaultModel { get; }

    UsageSnapshot SessionUsage { get; }

    IReadOnlyList<MetricCard> Metrics { get; }

    IReadOnlyList<ResourceSection> ResourceSections { get; }

    /// <summary>One line under the workspace header: what this page is looking at.</summary>
    string WorkspaceNote { get; }

    string TierLabel(ModelTier tier);

    string TierNote(ModelTier tier);

    string ToolLabel(ToolKind kind);
}
