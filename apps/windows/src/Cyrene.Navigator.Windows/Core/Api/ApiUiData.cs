// Core/Api/ApiUiData.cs
//
// Presentation data derived from the Navigator API / 由 Navigator API 派生的展示数据。
//
// Model catalogues, workspace metrics, and resource sheets are service data. The current
// Navigator contracts do not publish them, so this adapter reports empty lists and the views
// render "not reported" states instead of inventing figures.

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Api;

public sealed class ApiUiData : INavigatorUiData
{
    private readonly ApiConversationService _source;

    public ApiUiData(ApiConversationService source)
    {
        _source = source;
    }

    public IReadOnlyList<ModelDescriptor> Models => Array.Empty<ModelDescriptor>();

    /// <summary>An explicitly unnamed default: the workspace reported no model catalogue.</summary>
    public ModelDescriptor DefaultModel => new()
    {
        Name = "No model reported",
        Provider = "workspace",
    };

    public UsageSnapshot SessionUsage => _source.Projection.Usage;

    public IReadOnlyList<MetricCard> Metrics => Array.Empty<MetricCard>();

    public IReadOnlyList<ResourceSection> ResourceSections => Array.Empty<ResourceSection>();

    /// <summary>The workspace page states its connection, not a fabricated environment label.</summary>
    public string WorkspaceNote => _source.ConnectionDetail;

    public string TierLabel(ModelTier tier) => PresentationLabels.TierLabel(tier);

    public string TierNote(ModelTier tier) => PresentationLabels.TierNote(tier);

    public string ToolLabel(ToolKind kind) => PresentationLabels.ToolLabel(kind);
}
