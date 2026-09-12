// Views/SettingsPage.cs
//
// Settings destination / 设置页。
//
// This is the most system-layer surface in the app, so it deliberately uses the platform's own
// settings idiom: a category list on the left, scrolling grouped rows on the right, and stock
// WinUI controls — ToggleSwitch, ComboBox, RadioButtons, Slider — doing the actual work.
//
// The product layer only contributes the row's typography and the hairline surface. A Windows
// user should be able to operate this page without learning anything.
//
// The appearance switch is real: it re-tokenises the whole app and rebuilds the shell, which is
// also the proof that the design tokens are a single source of truth.
//
// 设置页用 Windows 原生设置体验：左侧分类 + 右侧分组行 + 原生控件。主题切换是真的可用的。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Controls;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Views;

public sealed class SettingsPage : Grid
{
    private static readonly (string Key, string Glyph, string Label, string Note)[] Sections =
    {
        ("appearance", "\uE790", "Appearance", "Theme, density, fonts"),
        ("account", "\uE77B", "Account", "Identity and sign-in"),
        ("workspace", "\uE950", "Workspace", "Workspace defaults"),
        ("models", "\uE9D9", "Models", "Providers and routing"),
        ("tools", "\uE90F", "Tools", "Capabilities and approvals"),
        ("plugins", "\uEA86", "Plugins", "Installed extensions"),
        ("privacy", "\uE72E", "Privacy", "What leaves this device"),
    };

    private readonly Border _content;
    private readonly Dictionary<string, Button> _rows = new();
    private readonly Dictionary<string, Border> _indicators = new();
    private readonly Action<CyreneTheme> _onThemeChanged;
    private string _current = "appearance";

    public SettingsPage(Action<CyreneTheme> onThemeChanged)
    {
        _onThemeChanged = onThemeChanged;
        Background = Tk.FillPaper;

        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        Children.Add(BuildSideNav().At(0));

        _content = new Border { Background = Tk.FillPaper };
        Children.Add(_content.At(1));

        Show("appearance");
    }

    // -----------------------------------------------------------------------------------------

    private FrameworkElement BuildSideNav()
    {
        var stack = new StackPanel { Orientation = Orientation.Vertical };
        stack.Children.Add(new Border
        {
            Padding = new Thickness(Tk.Sp.S20, Tk.Sp.S24, Tk.Sp.S16, Tk.Sp.S12),
            Child = Ui.VStack(4,
                Typo.Display("Settings", 22),
                Typo.Meta("Configured principal · Example Workspace", Tk.TextMuted)),
        });

        var list = new StackPanel { Orientation = Orientation.Vertical, Spacing = 1, Margin = new Thickness(Tk.Sp.S8, Tk.Sp.S8, Tk.Sp.S8, 0) };
        foreach (var section in Sections)
        {
            list.Children.Add(BuildNavRow(section));
        }

        stack.Children.Add(list);

        return new Border
        {
            Width = 268,
            Background = Tk.FillSand,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Right,
            Child = new ScrollViewer
            {
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollMode = ScrollMode.Disabled,
                Content = stack,
            },
        };
    }

    private FrameworkElement BuildNavRow((string Key, string Glyph, string Label, string Note) section)
    {
        var glyph = Typo.Glyph(section.Glyph, 15, Tk.TextSlate);
        glyph.Width = 26;

        var label = new TextBlock
        {
            Text = section.Label,
            FontFamily = Tk.Ty.Text,
            FontSize = 13.5,
            Foreground = Tk.TextSlate,
            VerticalAlignment = VerticalAlignment.Center,
        };

        var row = Ui.HStack(Tk.Sp.S10, glyph, label);
        row.Margin = new Thickness(Tk.Sp.S8, 0, 0, 0);

        var surface = new Button
        {
            Content = row,
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            CornerRadius = Tk.Rad.Md,
            Height = 36,
            Padding = new Thickness(0),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Left,
        };
        surface.PointerEntered += (_, _) =>
        {
            if (section.Key != _current) surface.Background = Tk.FillHover;
        };
        surface.PointerExited += (_, _) =>
        {
            surface.Background = section.Key == _current ? Tk.FillSelected : Tk.FillTransparent;
        };
        surface.Click += (_, _) => Show(section.Key);
        ToolTipService.SetToolTip(surface, section.Note);

        var indicator = new Border
        {
            Width = Tk.Ln.Indicator,
            Height = 16,
            Background = Tk.TraceLive,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(-4, 0, 0, 0),
            CornerRadius = new CornerRadius(1),
            Opacity = 0,
            IsHitTestVisible = false,
        };

        _rows[section.Key] = surface;
        _indicators[section.Key] = indicator;

        var host = new Grid();
        host.Children.Add(surface);
        host.Children.Add(indicator);
        return host;
    }

    private void Show(string key)
    {
        _current = key;
        foreach (var pair in _indicators)
        {
            pair.Value.Opacity = pair.Key == key ? 1 : 0;
        }

        foreach (var pair in _rows)
        {
            pair.Value.Background = pair.Key == key ? Tk.FillSelected : Tk.FillTransparent;
            if (pair.Value.Content is StackPanel panel && panel.Children.Count > 1)
            {
                if (panel.Children[0] is TextBlock g)
                {
                    g.Foreground = pair.Key == key ? Tk.TextInk : Tk.TextSlate;
                }

                if (panel.Children[1] is TextBlock l)
                {
                    l.Foreground = pair.Key == key ? Tk.TextInk : Tk.TextSlate;
                    l.FontWeight = pair.Key == key ? FontWeights.SemiBold : FontWeights.Normal;
                }
            }
        }

        var body = key switch
        {
            "account" => BuildAccount(),
            "workspace" => BuildWorkspace(),
            "models" => BuildModels(),
            "tools" => BuildTools(),
            "plugins" => BuildPlugins(),
            "privacy" => BuildPrivacy(),
            _ => BuildAppearance(),
        };

        _content.Child = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Disabled,
            Padding = new Thickness(Tk.Sp.S40, Tk.Sp.S24, Tk.Sp.S40, Tk.Sp.S56),
            Content = body,
        };
        Ui.FadeIn(_content, 140);
    }

    // -----------------------------------------------------------------------------------------
    // Row primitives
    // -----------------------------------------------------------------------------------------

    private static StackPanel Section(string title, string note, params FrameworkElement[] rows)
    {
        var stack = new StackPanel { Orientation = Orientation.Vertical, MaxWidth = 860 };
        stack.HorizontalAlignment = HorizontalAlignment.Left;

        stack.Children.Add(new Border
        {
            Padding = new Thickness(0, 0, 0, Tk.Sp.S8),
            Child = Ui.VStack(4,
                Typo.Display(title, 22),
                Typo.Meta(note, Tk.TextMuted)),
        });
        stack.Children.Add(Ui.HorizonRule(0.34));

        var group = new StackPanel
        {
            Orientation = Orientation.Vertical,
            Margin = new Thickness(0, Tk.Sp.S20, 0, 0),
            BorderBrush = Tk.Line,
            BorderThickness = new Thickness(0, 0, 0, 1),
        };
        foreach (var row in rows)
        {
            group.Children.Add(row);
        }

        stack.Children.Add(group);
        return stack;
    }

    /// <summary>
    /// One settings row: glyph, title, description, and the platform control that does the work.
    /// A hairline sheet row rather than a card — 7 categories of settings would otherwise become
    /// 40 individual boxes.
    /// </summary>
    private static FrameworkElement Row(string glyph, string title, string description, FrameworkElement control)
    {
        var icon = Typo.Glyph(glyph, 16, Tk.TextSlate);
        icon.Width = 24;
        icon.VerticalAlignment = VerticalAlignment.Center;

        var text = Ui.VStack(2,
            new TextBlock
            {
                Text = title,
                FontFamily = Tk.Ty.Text,
                FontSize = 14,
                Foreground = Tk.TextInk,
            },
            Typo.Meta(description, Tk.TextMuted));
        text.VerticalAlignment = VerticalAlignment.Center;

        control.VerticalAlignment = VerticalAlignment.Center;
        control.HorizontalAlignment = HorizontalAlignment.Right;

        var grid = new Grid { ColumnSpacing = Tk.Sp.S16 };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        grid.Children.Add(icon.At(0));
        grid.Children.Add(text.At(1));
        grid.Children.Add(control.At(2));

        return new Border
        {
            Padding = new Thickness(Tk.Sp.S4, Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16),
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
            Child = grid,
        };
    }

    private static ToggleSwitch Switch(bool on, string? onLabel = null, string? offLabel = null)
    {
        var toggle = new ToggleSwitch { IsOn = on, OnContent = onLabel ?? "On", OffContent = offLabel ?? "Off" };
        toggle.FontFamily = Tk.Ty.Text;
        toggle.FontSize = 12.5;
        return toggle;
    }

    private static ComboBox Choice(int selected, params string[] options)
    {
        var combo = new ComboBox { MinWidth = 200, FontFamily = Tk.Ty.Text, FontSize = 13.5 };
        foreach (var option in options)
        {
            combo.Items.Add(option);
        }

        combo.SelectedIndex = selected;
        return combo;
    }

    // -----------------------------------------------------------------------------------------
    // Sections
    // -----------------------------------------------------------------------------------------

    private FrameworkElement BuildAppearance()
    {
        var theme = Choice(Tk.Theme == CyreneTheme.Dark ? 1 : 0, "Light", "Dark", "Use system setting");
        theme.SelectionChanged += (_, _) =>
        {
            var next = theme.SelectedIndex == 1 ? CyreneTheme.Dark : CyreneTheme.Light;
            _onThemeChanged(next);
        };

        var density = new RadioButtons { MaxColumns = 3 };
        density.Items.Add("Comfortable");
        density.Items.Add("Compact");
        density.Items.Add("Dense");
        density.SelectedIndex = 0;

        var scale = new Slider
        {
            Minimum = 90,
            Maximum = 130,
            Value = 100,
            StepFrequency = 5,
            TickFrequency = 10,
            Width = 200,
            SnapsTo = Microsoft.UI.Xaml.Controls.Primitives.SliderSnapsTo.StepValues,
        };

        return Section("Appearance", "How Navigator looks on this device",
            Row("\uE790", "Theme", "Light is the designed default; dark is available.", theme),
            Row("\uE8B0", "Row density", "Affects lists and resource sheets, not prose.", density),
            Row("\uE8E0", "Text size", "Scales the reading column without changing chrome.", scale),
            Row("\uE7C4", "Show the trace in transcripts",
                "The gradient line marking where the current run is.", Switch(true, "Shown", "Hidden")),
            Row("\uE943", "Use Space Grotesk when installed",
                "Falls back to Segoe UI Variable Display otherwise.", Switch(true)),
            Row("\uE7F4", "Reduce motion", "Turns off the breathing marks on running steps.", Switch(false)));
    }

    private static FrameworkElement BuildAccount()
    {
        var avatar = new Border
        {
            Width = 44,
            Height = 44,
            CornerRadius = Tk.Rad.Md,
            Background = Tk.Edge,
            Child = new TextBlock
            {
                Text = "N",
                FontFamily = Tk.Ty.Display,
                FontSize = 20,
                FontWeight = FontWeights.SemiBold,
                Foreground = Tk.TextOnInk,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };

        var identity = Ui.HStack(Tk.Sp.S16,
            avatar,
            Ui.VStack(3,
                Typo.Title("Configured principal", 16),
                Typo.Meta("Identity is supplied by the Navigator API", Tk.TextMuted),
                Typo.Label("No personal profile is bundled with this client", Tk.Wash(Tk.Raw.Muted, 0.85))));

        return Section("Account", "Who you are signed in as",
            Row("\uE77B", "Identity", "Managed by the workspace identity provider.",
                Ui.Outline("Manage", "\uE8A7")),
            Row("\uE8D7", "Devices", "Device information is supplied by the identity provider.", Ui.Ghost("Review")),
            Row("\uE72E", "Sign out of this device", "Runs already started keep going on the server.",
                Ui.Outline("Sign out")),
            new Border
            {
                Padding = new Thickness(Tk.Sp.S4, Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16),
                BorderBrush = Tk.Line,
                BorderThickness = Tk.Ln.Top,
                Child = identity,
            });
    }

    private static FrameworkElement BuildWorkspace()
    {
        return Section("Workspace", "Defaults applied to new sessions in the configured workspace",
            Row("\uE950", "Default model", "Used when a new session does not specify one.",
                Choice(0, "No model reported", "Hosted model", "Workspace model", "On-device model")),
            Row("\uE7C4", "Default agent", "Determines which capabilities are available.",
                Choice(0, "Navigator Agent", "Read-only Agent", "Docs Agent")),
            Row("\uE8B7", "Project roots", "Where tools may read and write by default.",
                Ui.Outline("2 roots", "\uE8DA")),
            Row("\uE8C7", "Spend cap", "Configured by the workspace service.",
                Ui.Ghost("Change")),
            Row("\uE81C", "Keep transcripts", "Older sessions are archived, never deleted.",
                Choice(1, "30 days", "1 year", "Forever")));
    }

    private static FrameworkElement BuildModels()
    {
        return Section("Models", "Providers, routing and fallbacks",
            Row("\uE9D9", "Prefer workspace models when equivalent",
                "Keeps prompts inside the workspace where quality allows.", Switch(true)),
            Row("\uE945", "Fall back on provider outage",
                "Retry once on the workspace pool before reporting failure.", Switch(true)),
            Row("\uE896", "Prefix caching", "Reuses the system block across turns.", Switch(true)),
            Row("\uE713", "Hosted providers", "Configured by the connected service.",
                Ui.Outline("Manage", "\uE8A7")),
            Row("\uE977", "On-device runtime", "Status depends on the local native host.",
                Ui.Ghost("Install NPU runtime")));
    }

    private static FrameworkElement BuildTools()
    {
        return Section("Tools", "What agents may do, and when they must ask",
            Row("\uE8E5", "Read files inside project roots", "Never asks.", Switch(true, "Allowed")),
            Row("\uE70F", "Write files inside project roots", "Asks once per session.",
                Choice(1, "Never ask", "Ask once per session", "Ask every time")),
            Row("\uE756", "Run shell commands", "Asks for anything outside the allow-list.",
                Choice(1, "Never ask", "Ask for new commands", "Ask every time")),
            Row("\uE968", "Write to shared workspace resources",
                "Databases, deployments and endpoints. Always asks.",
                Choice(2, "Never ask", "Ask once per session", "Ask every time")),
            Row("\uE774", "External connectors", "Requests that leave your network.",
                Choice(2, "Never ask", "Ask once per session", "Ask every time")),
            Row("\uE81C", "Keep tool output", "Full responses are kept in the run log.", Switch(true)));
    }

    private static FrameworkElement BuildPlugins()
    {
        return Section("Plugins", "Installed extensions and their capabilities",
            Row("\uEA86", "Cyrene Native Host", "0.4.2 · file access, shell, watchers.",
                Ui.Ghost("Details")),
            Row("\uEA86", "Exchange Connector", "1.2.0 · catalogue and harness downloads.",
                Switch(true, "Enabled")),
            Row("\uEA86", "Yield Evaluation", "0.9.4 · batch evaluation on the workspace pool.",
                Switch(true, "Enabled")),
            Row("\uEA86", "Echo Telemetry", "2.0.1 · run traces and latency metrics.",
                Switch(true, "Enabled")),
            Row("\uE710", "Install from a manifest", "Plugins declare their capabilities up front.",
                Ui.Outline("Install…", "\uE8DA")));
    }

    private static FrameworkElement BuildPrivacy()
    {
        return Section("Privacy", "What leaves this device, and what never does",
            Row("\uE72E", "Send prompts to hosted providers",
                "Only for sessions using a hosted model.", Switch(true)),
            Row("\uE977", "Prefer on-device models for redaction work",
                "Redaction sessions stay offline by default.", Switch(true)),
            Row("\uE9D9", "Share anonymous usage metrics",
                "Counts and latencies only. Never prompt content.", Switch(false)),
            Row("\uE81C", "Store transcripts on this device",
                "Encrypted with the workspace key.", Switch(true)),
            Row("\uE74D", "Clear local cache", "3.4 GB of transcripts, artifacts and run logs.",
                Ui.Outline("Clear…")));
    }
}
