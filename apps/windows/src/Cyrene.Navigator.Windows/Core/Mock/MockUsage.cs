// Core/Mock/MockUsage.cs
//
// Mock token/cost accounting / 用量与成本（mock）。
//
// Usage is treated as a first-class part of the workspace context rather than a settings-page
// statistic, because deciding whether to keep going is a decision users make constantly.

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Mock;

public static class MockUsage
{
    /// <summary>Accounting for the session currently open.</summary>
    public static UsageSnapshot Session { get; } = new()
    {
        Reported = true,
        InputTokens = 184_320,
        OutputTokens = 27_940,
        CachedTokens = 121_600,
        ContextUsed = 0.62,
        CostUsd = 4.87,
        Latency = TimeSpan.FromMilliseconds(1_840),
        ToolCalls = 63,
    };

    /// <summary>Accounting for a single assistant turn, shown inline under the turn.</summary>
    public static UsageSnapshot LastTurn { get; } = new()
    {
        Reported = true,
        InputTokens = 12_486,
        OutputTokens = 2_104,
        CachedTokens = 9_920,
        ContextUsed = 0.62,
        CostUsd = 0.34,
        Latency = TimeSpan.FromMilliseconds(2_310),
        ToolCalls = 6,
    };

    public static UsageSnapshot Turn(int input, int output, int cached, double cost, int latencyMs, int tools) => new()
    {
        Reported = true,
        InputTokens = input,
        OutputTokens = output,
        CachedTokens = cached,
        ContextUsed = Math.Min(0.98, 0.18 + (input / 300_000.0)),
        CostUsd = cost,
        Latency = TimeSpan.FromMilliseconds(latencyMs),
        ToolCalls = tools,
    };

    /// <summary>Seven-day spend, normalised for the hairline sparklines on the workspace page.</summary>
    public static IReadOnlyList<double> WeeklySpend { get; } = new[]
    {
        0.32, 0.41, 0.38, 0.62, 0.71, 0.55, 0.86,
    };

    public static IReadOnlyList<double> WeeklyTokens { get; } = new[]
    {
        0.44, 0.52, 0.49, 0.58, 0.83, 0.61, 0.74,
    };

    public static IReadOnlyList<double> GpuUtilisation { get; } = new[]
    {
        0.71, 0.68, 0.82, 0.91, 0.77, 0.85, 0.79,
    };

    public static IReadOnlyList<double> Latency { get; } = new[]
    {
        0.61, 0.48, 0.52, 0.44, 0.39, 0.47, 0.36,
    };
}
