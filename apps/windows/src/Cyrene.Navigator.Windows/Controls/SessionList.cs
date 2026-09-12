// Controls/SessionList.cs
//
// Session list / 会话列表。
//
// Conversation-first means the first thing on screen is work in progress, so the list opens
// with a "Now" group holding whatever is running or waiting on you, then falls back to
// recency. There is no template gallery, no assistant picker and no feature menu.
//
// Rows are hairline sheet rows in the brand's idiom — a term, a value, a hairline — rather than
// cards. Cards in a sidebar cost 8px of padding per row and buy nothing; hairline rows let 14
// sessions fit where 7 cards would.
//
// 打开就看到"正在进行的工作"，而不是几十个 AI 功能入口。行用发丝线分隔而不是卡片。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Controls;

/// <summary>Marker used to render a group heading inside the same virtualized list.</summary>
public sealed class SessionGroupHeader
{
    public string Label { get; init; } = string.Empty;

    public int Count { get; init; }
}

public sealed class SessionList : Grid
{
    private readonly VirtualList _list;
    private readonly IReadOnlyList<SessionSummary> _allSessions;
    private readonly List<object> _rows = new();
    private readonly Dictionary<string, Border> _indicators = new();
    private readonly Dictionary<string, Button> _surfaces = new();
    private string _selectedId = string.Empty;

    public event Action<SessionSummary>? Opened;

    public SessionList(IReadOnlyList<SessionSummary> sessions)
    {
        _allSessions = sessions;
        Width = 296;
        Background = Tk.FillSand;
        BorderBrush = Tk.Line;
        BorderThickness = Tk.Ln.Right;

        RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        RowDefinitions.Add(new RowDefinition { Height = Ui.Star() });

        Children.Add(BuildHeader().At(0, 0));
        Children.Add(BuildSearch().At(0, 1));

        BuildRows(sessions);
        if (sessions.Count == 0)
        {
            _rows.Add(new SessionGroupHeader { Label = "No sessions reported", Count = 0 });
        }

        _list = new VirtualList(BuildRow) { ItemsSource = _rows, Padding = new Thickness(0, 0, 0, Tk.Sp.S24) };
        Children.Add(_list.At(0, 2));

        if (sessions.Count > 0)
        {
            Select(sessions[0].Id);
        }
    }

    // -----------------------------------------------------------------------------------------

    private FrameworkElement BuildHeader()
    {
        var title = Typo.Eyebrow("sessions");
        title.VerticalAlignment = VerticalAlignment.Center;

        var add = Ui.IconButton("\uE710", "New session  ·  Ctrl+N", 28);
        add.HorizontalAlignment = HorizontalAlignment.Right;

        var filter = Ui.IconButton("\uE71C", "Filter and sort", 28);
        filter.HorizontalAlignment = HorizontalAlignment.Right;
        filter.Flyout = BuildFilterMenu();

        var row = new Grid { Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S8, Tk.Sp.S6) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.Children.Add(title.At(0));
        row.Children.Add(filter.At(1));
        row.Children.Add(add.At(2));
        return row;
    }

    private static MenuFlyout BuildFilterMenu()
    {
        var flyout = new MenuFlyout();
        flyout.Items.Add(new ToggleMenuFlyoutItem { Text = "Group by recency", IsChecked = true });
        flyout.Items.Add(new ToggleMenuFlyoutItem { Text = "Group by project" });
        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(new ToggleMenuFlyoutItem { Text = "Only running", IsChecked = false });
        flyout.Items.Add(new ToggleMenuFlyoutItem { Text = "Only needing attention", IsChecked = false });
        return flyout;
    }

    private FrameworkElement BuildSearch()
    {
        var box = new TextBox
        {
            PlaceholderText = "Search sessions",
            FontFamily = Tk.Ty.Text,
            FontSize = 13,
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            Padding = new Thickness(Tk.Sp.S8, Tk.Sp.S6, Tk.Sp.S8, Tk.Sp.S6),
        };
        box.TextChanged += (_, _) => ApplyFilter(box.Text);

        var glyph = Typo.Glyph("\uE721", 13, Tk.Wash(Tk.Raw.Muted, 0.8));

        var row = new Grid { ColumnSpacing = Tk.Sp.S4 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.Children.Add(glyph.At(0));
        row.Children.Add(box.At(1));

        return new Border
        {
            Margin = new Thickness(Tk.Sp.S12, 0, Tk.Sp.S12, Tk.Sp.S8),
            Padding = new Thickness(Tk.Sp.S8, 0, 0, 0),
            Background = Tk.FillPaper,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Md,
            Child = row,
        };
    }

    private void ApplyFilter(string? query)
    {
        var q = query?.Trim();
        var filtered = new List<SessionSummary>();
        if (string.IsNullOrEmpty(q))
        {
            filtered.AddRange(_allSessions);
        }
        else
        {
            foreach (var s in _allSessions)
            {
                if (s.Title.Contains(q, StringComparison.OrdinalIgnoreCase) ||
                    s.Project.Contains(q, StringComparison.OrdinalIgnoreCase) ||
                    s.Preview.Contains(q, StringComparison.OrdinalIgnoreCase))
                {
                    filtered.Add(s);
                }
            }
        }

        BuildRows(filtered);
        _list.ItemsSource = null;
        _list.ItemsSource = _rows;
    }

    private void BuildRows(IReadOnlyList<SessionSummary> sessions)
    {
        _rows.Clear();
        var currentBucket = string.Empty;

        foreach (var session in sessions)
        {
            if (session.Bucket != currentBucket)
            {
                currentBucket = session.Bucket;
                var count = 0;
                foreach (var candidate in sessions)
                {
                    if (candidate.Bucket == currentBucket)
                    {
                        count++;
                    }
                }

                _rows.Add(new SessionGroupHeader { Label = currentBucket, Count = count });
            }

            _rows.Add(session);
        }
    }

    private FrameworkElement? BuildRow(object item) => item switch
    {
        SessionGroupHeader header => BuildGroupHeader(header),
        SessionSummary session => BuildSessionRow(session),
        _ => null,
    };

    private static FrameworkElement BuildGroupHeader(SessionGroupHeader header)
    {
        var row = new Grid
        {
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S6),
            ColumnSpacing = Tk.Sp.S8,
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        var accent = header.Label == "Now" ? Tk.Coral : Tk.Wash(Tk.Raw.Muted, 0.9);
        row.Children.Add(Typo.Eyebrow(header.Label, accent).At(0));

        var line = new Border { Height = 1, Background = Tk.Line, VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(line.At(1));

        row.Children.Add(Typo.Mono(
            header.Count.ToString(System.Globalization.CultureInfo.InvariantCulture),
            Tk.Wash(Tk.Raw.Muted, 0.7),
            11).At(2));

        return row;
    }

    /// <summary>
    /// One session row. The activity diamond is the only colour: gradient-filled means something
    /// is running, coral hollow means it is waiting on you, danger means it stopped. A calm
    /// session gets a hairline diamond and no colour at all.
    /// </summary>
    private FrameworkElement BuildSessionRow(SessionSummary session)
    {
        var title = new TextBlock
        {
            Text = session.Title,
            FontFamily = Tk.Ty.Text,
            FontSize = 13.5,
            Foreground = Tk.TextInk,
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextWrapping = TextWrapping.NoWrap,
        };

        var preview = Typo.Meta(session.Preview, ActivityBrush(session.Activity, muted: true));

        var meta = Ui.HStack(Tk.Sp.S8,
            Typo.Label(session.ModelLabel, Tk.Wash(Tk.Raw.Muted, 0.85)),
            Typo.Label("·", Tk.Wash(Tk.Raw.Muted, 0.4)),
            Typo.Label(session.Project, Tk.Wash(Tk.Raw.Muted, 0.7)));

        var texts = Ui.VStack(3, title, preview, meta);

        var head = new Grid { ColumnSpacing = Tk.Sp.S8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(14) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        var mark = ActivityMark(session.Activity);
        mark.VerticalAlignment = VerticalAlignment.Top;
        mark.Margin = new Thickness(0, 5, 0, 0);
        head.Children.Add(mark.At(0));
        head.Children.Add(texts.At(1));

        var right = Ui.VStack(4);
        right.HorizontalAlignment = HorizontalAlignment.Right;
        right.Children.Add(Typo.Mono(Ui.Ago(session.UpdatedAt, DateTimeOffset.Now), Tk.Wash(Tk.Raw.Muted, 0.8), 11));
        if (session.IsPinned)
        {
            var pin = Typo.Glyph("\uE718", 11, Tk.Wash(Tk.Raw.Muted, 0.7));
            pin.HorizontalAlignment = HorizontalAlignment.Right;
            right.Children.Add(pin);
        }

        head.Children.Add(right.At(2));

        var surface = new Button
        {
            Content = head,
            Background = Tk.FillTransparent,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
            CornerRadius = Tk.Rad.None,
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S10, Tk.Sp.S12, Tk.Sp.S10),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
        surface.PointerEntered += (_, _) =>
        {
            if (session.Id != _selectedId)
            {
                surface.Background = Tk.FillHover;
            }
        };
        surface.PointerExited += (_, _) =>
        {
            surface.Background = session.Id == _selectedId ? Tk.FillSelected : Tk.FillTransparent;
        };
        surface.Click += (_, _) =>
        {
            Select(session.Id);
            Opened?.Invoke(session);
        };
        surface.ContextFlyout = BuildRowMenu(session);
        ToolTipService.SetToolTip(surface,
            $"{session.Title}\n{session.Project} · {session.TurnCount} turns · {session.ModelLabel}");

        var indicator = new Border
        {
            Width = Tk.Ln.Indicator,
            Background = Tk.TraceLive,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Stretch,
            Margin = new Thickness(0, Tk.Sp.S6, 0, Tk.Sp.S6),
            CornerRadius = new CornerRadius(1),
            Opacity = session.Id == _selectedId ? 1 : 0,
            IsHitTestVisible = false,
        };

        if (session.Id == _selectedId)
        {
            surface.Background = Tk.FillSelected;
        }

        _indicators[session.Id] = indicator;
        _surfaces[session.Id] = surface;

        var host = new Grid();
        host.Children.Add(surface);
        host.Children.Add(indicator);
        return host;
    }

    private static MenuFlyout BuildRowMenu(SessionSummary session)
    {
        var flyout = new MenuFlyout();

        var pin = new MenuFlyoutItem
        {
            Text = session.IsPinned ? "Unpin" : "Pin to top",
            Icon = new FontIcon { Glyph = "\uE718" },
        };
        flyout.Items.Add(pin);

        flyout.Items.Add(new MenuFlyoutItem { Text = "Rename", Icon = new FontIcon { Glyph = "\uE8AC" } });
        flyout.Items.Add(new MenuFlyoutItem { Text = "Duplicate", Icon = new FontIcon { Glyph = "\uE8C8" } });

        var move = new MenuFlyoutSubItem { Text = "Move to project", Icon = new FontIcon { Glyph = "\uE8B7" } };
        move.Items.Add(new MenuFlyoutItem { Text = "cyrene-navigator" });
        move.Items.Add(new MenuFlyoutItem { Text = "cyrene-platform" });
        move.Items.Add(new MenuFlyoutItem { Text = "cyrene-workspace" });
        flyout.Items.Add(move);

        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(new MenuFlyoutItem { Text = "Export transcript…", Icon = new FontIcon { Glyph = "\uE74E" } });

        var delete = new MenuFlyoutItem { Text = "Delete", Icon = new FontIcon { Glyph = "\uE74D" } };
        delete.Foreground = Tk.Danger;
        flyout.Items.Add(delete);

        return flyout;
    }

    public void Select(string sessionId)
    {
        _selectedId = sessionId;
        foreach (var pair in _indicators)
        {
            pair.Value.Opacity = pair.Key == sessionId ? 1 : 0;
        }

        foreach (var pair in _surfaces)
        {
            pair.Value.Background = pair.Key == sessionId ? Tk.FillSelected : Tk.FillTransparent;
        }
    }

    private static FrameworkElement ActivityMark(SessionActivity activity) => activity switch
    {
        SessionActivity.Running => Running(),
        SessionActivity.AwaitingApproval => Ui.Diamond(Tk.Coral, Tk.FillSand, 7),
        SessionActivity.Failed => Ui.Diamond(Tk.Danger, Tk.Wash(Tk.Raw.Danger, 0.12), 7),
        _ => Ui.Diamond(Tk.Wash(Tk.Raw.HairStrong, 0.9), Tk.FillSand, 6),
    };

    private static FrameworkElement Running()
    {
        var mark = Ui.SolidDiamond(8);
        Ui.Breathe(mark, 0.5, 1);
        return mark;
    }

    private static Brush ActivityBrush(SessionActivity activity, bool muted) => activity switch
    {
        SessionActivity.Running => Tk.Wash(Tk.Raw.Coral, muted ? 0.95 : 1),
        SessionActivity.AwaitingApproval => Tk.Wash(Tk.Raw.Coral, muted ? 0.95 : 1),
        SessionActivity.Failed => Tk.Danger,
        _ => Tk.TextMuted,
    };
}
