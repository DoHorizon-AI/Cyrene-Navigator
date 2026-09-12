// Views/WorkspacePage.cs
//
// Workspace destination / 工作区页。
//
// Resource pages are where products usually turn into admin dashboards: a wall of cards, each
// with its own border, shadow and chart. This one is built as a *spec sheet* instead, which is
// the brand's own idiom — figures separated by 1px gaps, sections that are hairline sheets of
// rows, and no container that does not carry information.
//
// The one place colour appears is the figures themselves (gradient numerals) and the load
// meters. Everything else is ink on paper.
//
// 用"规格表"而不是"卡片墙"。1px 发丝线网格 + 渐变数字 —— 信息密度高但仍然干净。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Controls;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Views;

public sealed class WorkspacePage : Grid
{
    private readonly INavigatorUiData _data;

    public WorkspacePage(INavigatorUiData data)
    {
        _data = data;
        Background = Tk.FillPaper;

        var stack = new StackPanel { Orientation = Orientation.Vertical, MaxWidth = 1180 };
        stack.HorizontalAlignment = HorizontalAlignment.Left;

        stack.Children.Add(BuildHeader(_data));
        stack.Children.Add(BuildMetricSheet(_data));

        if (_data.ResourceSections.Count == 0)
        {
            stack.Children.Add(BuildEmptyState(
                "resources",
                "No workspace resources reported",
                "The connected service did not report models, nodes, endpoints, or users."));
        }
        else
        {
            foreach (var section in _data.ResourceSections)
            {
                stack.Children.Add(BuildSection(section.Eyebrow, section.Title, section.Note, section.Rows));
            }
        }

        Children.Add(new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Disabled,
            Padding = new Thickness(Tk.Sp.S32, 0, Tk.Sp.S32, Tk.Sp.S56),
            Content = stack,
        });
    }

    // -----------------------------------------------------------------------------------------

    private static FrameworkElement BuildHeader(INavigatorUiData data)
    {
        var titles = Ui.VStack(4,
            Typo.Display("Workspace", 24),
            Typo.Meta(data.WorkspaceNote, Tk.TextMuted));

        var actions = Ui.HStack(Tk.Sp.S4,
            Ui.Ghost("Invite", "\uE8FA"),
            Ui.Ghost("Billing", "\uE8C7"),
            Ui.Outline("Add model", "\uE710"));
        actions.HorizontalAlignment = HorizontalAlignment.Right;

        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.Children.Add(titles.At(0));
        row.Children.Add(actions.At(1));

        var stack = new StackPanel { Orientation = Orientation.Vertical };
        stack.Children.Add(new Border { Padding = new Thickness(0, Tk.Sp.S24, 0, Tk.Sp.S16), Child = row });
        stack.Children.Add(Ui.HorizonRule(0.42));
        return stack;
    }

    /// <summary>
    /// The figure sheet. Cells are separated by 1px of the container's own fill showing through,
    /// exactly the way the brand builds its capability grid — no card borders, no shadows.
    /// </summary>
    private static FrameworkElement BuildMetricSheet(INavigatorUiData data)
    {
        var metrics = data.Metrics;
        if (metrics.Count == 0)
        {
            return BuildEmptyState(
                "metrics",
                "No workspace metrics reported",
                "Session counts, token totals, spend, GPU and latency figures come from the "
                    + "connected service; this connection reported none.");
        }

        var grid = new Grid
        {
            Background = Tk.Line,
            ColumnSpacing = 1,
            RowSpacing = 1,
            BorderBrush = Tk.Line,
            BorderThickness = new Thickness(0, 1, 0, 1),
            Margin = new Thickness(0, Tk.Sp.S24, 0, Tk.Sp.S40),
        };

        for (var c = 0; c < 3; c++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        }

        grid.RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });

        for (var i = 0; i < metrics.Count; i++)
        {
            var metric = metrics[i];
            var body = Ui.VStack(Tk.Sp.S8,
                Typo.Label(metric.Label, Tk.TextMuted),
                Typo.Metric(metric.Value, 30),
                Typo.Meta(metric.Delta, Tk.Wash(Tk.Raw.Muted, 0.9)),
                Ui.Sparkline(metric.Series, 22));

            var cell = new Border
            {
                Background = Tk.FillPaper,
                Padding = new Thickness(Tk.Sp.S20, Tk.Sp.S16, Tk.Sp.S20, Tk.Sp.S20),
                Child = body,
            };
            cell.Interactive(Tk.Wash(Tk.Raw.SandDeep, 0.7), Tk.FillPaper);
            grid.Children.Add(cell.At(i % 3, i / 3));
        }

        return grid;
    }


    /// <summary>
    /// A section-shaped empty state. Missing service data is stated, never filled with figures.
    /// </summary>
    private static FrameworkElement BuildEmptyState(string eyebrow, string title, string note)
    {
        var head = Ui.VStack(Tk.Sp.S4,
            Typo.Eyebrow(eyebrow, Tk.Orchid),
            Ui.HStack(Tk.Sp.S12,
                Typo.Title(title, 19),
                Typo.Meta(note, Tk.TextMuted)));

        return Ui.VStack(0,
            new Border { Padding = new Thickness(0, Tk.Sp.S24, 0, Tk.Sp.S8), Child = head },
            new Border { Height = Tk.Sp.S40 });
    }

    /// <summary>
    /// A section is a hairline sheet: tracked heading, a horizon rule, then rows. Rows are the
    /// brand's research-list pattern — hairline separated, warm hover, no card chrome.
    /// </summary>
    private static FrameworkElement BuildSection(string eyebrow, string title, string note, IReadOnlyList<ResourceRow> rows)
    {
        var head = Ui.VStack(Tk.Sp.S4,
            Typo.Eyebrow(eyebrow, Tk.Orchid),
            Ui.HStack(Tk.Sp.S12,
                Typo.Title(title, 19),
                Typo.Meta(note, Tk.TextMuted)));

        var body = new StackPanel
        {
            Orientation = Orientation.Vertical,
            BorderBrush = Tk.Line,
            BorderThickness = new Thickness(0, 0, 0, 1),
            Margin = new Thickness(0, Tk.Sp.S12, 0, 0),
        };

        foreach (var row in rows)
        {
            body.Children.Add(BuildResourceRow(row));
        }

        return Ui.VStack(0,
            new Border { Padding = new Thickness(0, 0, 0, Tk.Sp.S8), Child = head },
            body,
            new Border { Height = Tk.Sp.S40 });
    }

    private static FrameworkElement BuildResourceRow(ResourceRow row)
    {
        var primary = new TextBlock
        {
            Text = row.Primary,
            FontFamily = Tk.Ty.Display,
            FontSize = 14,
            FontWeight = FontWeights.SemiBold,
            Foreground = Tk.TextInk,
            TextTrimming = TextTrimming.CharacterEllipsis,
        };

        var texts = Ui.VStack(2, primary, Typo.Meta(row.Secondary, Tk.TextMuted));

        var meter = Ui.Meter(row.Load, 120, 3, HealthBrush(row.Health));
        meter.VerticalAlignment = VerticalAlignment.Center;

        var metric = Ui.VStack(3,
            Typo.Figure(row.Metric, 15),
            Typo.Label(row.MetricLabel, Tk.Wash(Tk.Raw.Muted, 0.85)));
        metric.HorizontalAlignment = HorizontalAlignment.Right;

        var health = Ui.HStack(Tk.Sp.S6,
            Ui.Diamond(HealthBrush(row.Health), HealthFill(row.Health), 6),
            Typo.Label(HealthLabel(row.Health), HealthBrush(row.Health)));

        var grid = new Grid { ColumnSpacing = Tk.Sp.S24 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star(1.6) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(120) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(110) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(96) });
        grid.Children.Add(texts.At(0));
        grid.Children.Add(meter.At(1));
        grid.Children.Add(metric.At(2));
        grid.Children.Add(health.At(3));

        var host = new Border
        {
            Padding = new Thickness(Tk.Sp.S4, Tk.Sp.S12, Tk.Sp.S12, Tk.Sp.S12),
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
            Background = Tk.FillTransparent,
            Child = grid,
        };
        host.Interactive(Tk.FillSandDeep, Tk.FillTransparent);
        host.ContextFlyout = BuildRowMenu();
        return host;
    }

    private static MenuFlyout BuildRowMenu()
    {
        var flyout = new MenuFlyout();
        flyout.Items.Add(new MenuFlyoutItem { Text = "Open details", Icon = new FontIcon { Glyph = "\uE8A7" } });
        flyout.Items.Add(new MenuFlyoutItem { Text = "View metrics", Icon = new FontIcon { Glyph = "\uE9D9" } });
        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(new MenuFlyoutItem { Text = "Copy identifier", Icon = new FontIcon { Glyph = "\uE8C8" } });
        return flyout;
    }

    // -----------------------------------------------------------------------------------------
    // Fixtures
    // -----------------------------------------------------------------------------------------

    private static Brush HealthBrush(ResourceHealth health) => health switch
    {
        ResourceHealth.Healthy => Tk.Success,
        ResourceHealth.Busy => Tk.Orchid,
        ResourceHealth.Degraded => Tk.Warn,
        _ => Tk.Wash(Tk.Raw.Muted, 0.7),
    };

    private static Brush HealthFill(ResourceHealth health) => health switch
    {
        ResourceHealth.Healthy => Tk.SuccessWash,
        ResourceHealth.Busy => Tk.BrandWash,
        ResourceHealth.Degraded => Tk.Wash(Tk.Raw.Warn, 0.14),
        _ => Tk.FillPaper,
    };

    private static string HealthLabel(ResourceHealth health) => health switch
    {
        ResourceHealth.Healthy => "healthy",
        ResourceHealth.Busy => "busy",
        ResourceHealth.Degraded => "degraded",
        _ => "offline",
    };
}
