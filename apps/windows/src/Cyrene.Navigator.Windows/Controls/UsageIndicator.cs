// Controls/UsageIndicator.cs
//
// Usage / 用量指示。
//
// Two forms, one idea. Usage belongs where a decision gets made, so:
//
//   Inline  — a single quiet hairline row at the end of a turn: what it cost, how long it took.
//   Compact — a context meter in the session header, because "how full is the window" changes
//             what you do next.
//
// Neither form is allowed to be loud. Figures use the mono face; only the context meter gets the
// brand gradient, and only because it is the number people act on.
//
// 用量放在"要做决定的地方"，不是放在设置页里的统计。

using System;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Cyrene.Navigator.Windows.Controls;

public static class UsageIndicator
{
    /// <summary>End-of-turn accounting row. Deliberately one line, deliberately quiet.</summary>
    public static FrameworkElement Inline(UsageSnapshot usage)
    {
        if (!usage.Reported)
        {
            return new Border
            {
                Padding = new Thickness(0, Tk.Sp.S6, 0, Tk.Sp.S6),
                Child = Typo.Meta("usage not reported by the connected service", Tk.Wash(Tk.Raw.Muted, 0.8)),
            };
        }

        var row = Ui.HStack(Tk.Sp.S16);
        row.VerticalAlignment = VerticalAlignment.Center;

        row.Children.Add(Field("in", Ui.Tokens(usage.InputTokens)));
        row.Children.Add(Field("out", Ui.Tokens(usage.OutputTokens)));

        if (usage.CachedTokens > 0)
        {
            row.Children.Add(Field("cached", Ui.Tokens(usage.CachedTokens), Tk.Success));
        }

        row.Children.Add(Field("cost", "$" + usage.CostUsd.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture)));
        row.Children.Add(Field("latency", Ui.Duration(usage.Latency)));

        if (usage.ToolCalls > 0)
        {
            row.Children.Add(Field("tools", usage.ToolCalls.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        }

        return new Border
        {
            Padding = new Thickness(0, Tk.Sp.S6, 0, Tk.Sp.S6),
            Child = row,
        };
    }

    /// <summary>Context-window meter for the session header.</summary>
    public static FrameworkElement Compact(UsageSnapshot usage)
    {
        if (!usage.Reported)
        {
            return new Border
            {
                Padding = new Thickness(Tk.Sp.S10, Tk.Sp.S4, Tk.Sp.S10, Tk.Sp.S4),
                Child = Typo.Label("usage not reported", Tk.Wash(Tk.Raw.Muted, 0.85)),
            };
        }

        var percent = (int)Math.Round(usage.ContextUsed * 100);

        var meter = Ui.Meter(usage.ContextUsed, 64, 3);
        meter.VerticalAlignment = VerticalAlignment.Center;

        var stack = Ui.HStack(Tk.Sp.S8,
            Typo.Label("context", Tk.TextMuted),
            meter,
            Typo.Mono(percent + "%", Tk.TextSlate, 11.5),
            Ui.VDivider(),
            Typo.Mono("$" + usage.CostUsd.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture), Tk.TextSlate, 11.5));

        var host = new Border
        {
            Padding = new Thickness(Tk.Sp.S10, Tk.Sp.S4, Tk.Sp.S10, Tk.Sp.S4),
            CornerRadius = Tk.Rad.Xs,
            Child = stack,
        };

        ToolTipService.SetToolTip(host,
            $"{Ui.Tokens(usage.Total)} tokens this session · {Ui.Tokens(usage.CachedTokens)} served from cache\n"
            + $"{percent}% of the context window · ${usage.CostUsd:0.00} · {usage.ToolCalls} tool calls");

        return host;
    }

    /// <summary>Workspace-page figure: tracked caption over a gradient numeral.</summary>
    public static FrameworkElement Stat(string label, string value, string? note = null, bool emphasise = true)
    {
        var stack = Ui.VStack(Tk.Sp.S6,
            Typo.Label(label, Tk.TextMuted),
            emphasise ? Typo.Metric(value) : Typo.Figure(value));

        if (note is not null)
        {
            stack.Children.Add(Typo.Meta(note, Tk.TextMuted));
        }

        return stack;
    }

    private static FrameworkElement Field(string label, string value, Microsoft.UI.Xaml.Media.Brush? valueBrush = null) =>
        Ui.HStack(Tk.Sp.S6,
            Typo.Label(label, Tk.Wash(Tk.Raw.Muted, 0.75)),
            Typo.Mono(value, valueBrush ?? Tk.TextSlate, 11.5));
}
