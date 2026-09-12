// Core/Mock/MockUiData.cs
//
// Composition-root presentation fixture / composition root 展示 fixture。
//
// Preview only: this fixture is compiled into Debug builds and selected with
// CYRENE_NAVIGATOR_UI_PREVIEW=mock. It never represents a real workspace observation.

using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core;

namespace Cyrene.Navigator.Windows.Core.Mock;

public sealed class MockUiData : INavigatorUiData
{
    public IReadOnlyList<ModelDescriptor> Models => MockModels.All;

    public ModelDescriptor DefaultModel => MockModels.Default;

    public UsageSnapshot SessionUsage => MockUsage.Session;

    public IReadOnlyList<MetricCard> Metrics => MockWorkspace.Metrics;

    public IReadOnlyList<ResourceSection> ResourceSections => MockWorkspace.Sections;

    public string WorkspaceNote => "demo-workspace  ·  example-region  ·  you are a member";

    public string TierLabel(ModelTier tier) => PresentationLabels.TierLabel(tier);

    public string TierNote(ModelTier tier) => PresentationLabels.TierNote(tier);

    public string ToolLabel(ToolKind kind) => PresentationLabels.ToolLabel(kind);
}
