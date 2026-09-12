// Core/Mock/MockWorkspace.cs
//
// Workspace-page preview fixtures / 工作区页预览 fixture。
//
// These rows and figures exist so the preview shows a populated workspace. They are Debug-only
// preview material; the real adapter reports empty lists and the view renders "not reported".

using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core;

namespace Cyrene.Navigator.Windows.Core.Mock;

public static class MockWorkspace
{
    public static IReadOnlyList<MetricCard> Metrics { get; } = new List<MetricCard>
    {
        new() { Label = "active sessions", Value = "14", Delta = "+3 today", Series = MockUsage.WeeklyTokens },
        new() { Label = "runs today", Value = "126", Delta = "9 needed approval", Series = MockUsage.WeeklySpend },
        new() { Label = "tokens · 7d", Value = "48.2M", Delta = "71% cache hit", Series = MockUsage.WeeklyTokens },
        new() { Label = "spend · 7d", Value = "$412", Delta = "under the $600 cap", Series = MockUsage.WeeklySpend },
        new() { Label = "gpu utilisation", Value = "78%", Delta = "12 devices", Series = MockUsage.GpuUtilisation },
        new() { Label = "p95 latency", Value = "186ms", Delta = "end of turn", Series = MockUsage.Latency },
    };

    public static IReadOnlyList<ResourceSection> Sections { get; } = new List<ResourceSection>
    {
        new()
        {
            Eyebrow = "models",
            Title = "Models",
            Note = "6 available · 2 served from this workspace",
            Rows = ModelRows(),
        },
        new()
        {
            Eyebrow = "compute",
            Title = "GPU nodes",
            Note = "3 nodes · 12 devices · 78% mean utilisation",
            Rows = NodeRows(),
        },
        new()
        {
            Eyebrow = "endpoints",
            Title = "Endpoints",
            Note = "5 published · 1 degraded",
            Rows = EndpointRows(),
        },
        new()
        {
            Eyebrow = "people",
            Title = "Users",
            Note = "8 members · 2 owners",
            Rows = UserRows(),
        },
    };

    private static IReadOnlyList<ResourceRow> ModelRows()
    {
        var rows = new List<ResourceRow>();
        foreach (var model in MockModels.All)
        {
            rows.Add(new ResourceRow
            {
                Primary = model.Name,
                Secondary = PresentationLabels.TierLabel(model.Tier) + "  ·  " + model.Provider
                    + "  ·  " + model.ContextLabel + " context",
                Metric = model.Tier == ModelTier.Hosted
                    ? "metered"
                    : model.Tier == ModelTier.Workspace ? "pooled" : "local",
                MetricLabel = "billing",
                Health = model.Unavailable is null
                    ? model.Tier == ModelTier.Workspace ? ResourceHealth.Busy : ResourceHealth.Healthy
                    : ResourceHealth.Offline,
                Load = model.Tier switch
                {
                    ModelTier.Workspace => 0.82,
                    ModelTier.Local => 0.14,
                    _ => 0.46,
                },
            });
        }

        return rows;
    }

    private static IReadOnlyList<ResourceRow> NodeRows() => new List<ResourceRow>
    {
        new()
        {
            Primary = "demo-gpu-01",
            Secondary = "4 × Demo GPU 80GB  ·  Example Multimodal  ·  demo-driver",
            Metric = "91%",
            MetricLabel = "utilisation",
            Health = ResourceHealth.Busy,
            Load = 0.91,
        },
        new()
        {
            Primary = "demo-gpu-02",
            Secondary = "4 × Demo GPU 80GB  ·  Example Local 32B  ·  demo-driver",
            Metric = "74%",
            MetricLabel = "utilisation",
            Health = ResourceHealth.Healthy,
            Load = 0.74,
        },
        new()
        {
            Primary = "demo-gpu-03",
            Secondary = "4 × Demo GPU 40GB  ·  eval queue  ·  6 shards pending",
            Metric = "68%",
            MetricLabel = "utilisation",
            Health = ResourceHealth.Healthy,
            Load = 0.68,
        },
        new()
        {
            Primary = "this device",
            Secondary = "Demo GPU 24GB  ·  Example Local 8B via native host",
            Metric = "14%",
            MetricLabel = "utilisation",
            Health = ResourceHealth.Healthy,
            Load = 0.14,
        },
    };

    private static IReadOnlyList<ResourceRow> EndpointRows() => new List<ResourceRow>
    {
        new()
        {
            Primary = "harness.example.invalid",
            Secondary = "Harness transport  ·  mTLS  ·  4 active sessions",
            Metric = "142ms",
            MetricLabel = "p95",
            Health = ResourceHealth.Healthy,
            Load = 0.38,
        },
        new()
        {
            Primary = "models.example.invalid",
            Secondary = "Inference gateway  ·  mTLS  ·  2 pools",
            Metric = "186ms",
            MetricLabel = "p95",
            Health = ResourceHealth.Healthy,
            Load = 0.62,
        },
        new()
        {
            Primary = "exchange.example.invalid",
            Secondary = "External connector  ·  catalogue  ·  shard demo-shard-1 draining",
            Metric = "503",
            MetricLabel = "last status",
            Health = ResourceHealth.Degraded,
            Load = 0.94,
        },
        new()
        {
            Primary = "yield.example.invalid",
            Secondary = "Evaluation service  ·  mTLS  ·  6 jobs queued",
            Metric = "2.1s",
            MetricLabel = "p95",
            Health = ResourceHealth.Busy,
            Load = 0.71,
        },
        new()
        {
            Primary = "echo.example.invalid",
            Secondary = "Telemetry sink  ·  mTLS  ·  ingest only",
            Metric = "22ms",
            MetricLabel = "p95",
            Health = ResourceHealth.Healthy,
            Load = 0.17,
        },
    };

    private static IReadOnlyList<ResourceRow> UserRows() => new List<ResourceRow>
    {
        new()
        {
            Primary = "Example User",
            Secondary = "Member  ·  you  ·  last active now",
            Metric = "$186",
            MetricLabel = "spend · 7d",
            Health = ResourceHealth.Healthy,
            Load = 0.61,
        },
        new()
        {
            Primary = "Example Owner",
            Secondary = "Owner  ·  platform  ·  last active 12m ago",
            Metric = "$94",
            MetricLabel = "spend · 7d",
            Health = ResourceHealth.Healthy,
            Load = 0.34,
        },
        new()
        {
            Primary = "Example Engineer",
            Secondary = "Engineer  ·  harness  ·  last active 2h ago",
            Metric = "$78",
            MetricLabel = "spend · 7d",
            Health = ResourceHealth.Healthy,
            Load = 0.28,
        },
        new()
        {
            Primary = "eval-runner",
            Secondary = "Service account  ·  batch evaluation  ·  scheduled",
            Metric = "$54",
            MetricLabel = "spend · 7d",
            Health = ResourceHealth.Busy,
            Load = 0.88,
        },
    };
}
