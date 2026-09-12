// Controls/CyreneNavigation.cs
//
// Primary navigation rail / 一级导航。
//
// This is a Windows system-layer surface, so it behaves like Windows: Segoe Fluent icons, a
// 48px rail that expands to 224px, Windows 11 hover/pressed/selected washes, tooltips when
// collapsed, keyboard focus, and Alt-number accelerators.
//
// One thing is not stock Windows: the selection indicator is a 2px brand gradient bar rather
// than the platform's accent pill. That is a deliberate single point of contact between the two
// layers — it is the same gesture as the website's active nav underline, rotated 90°, and it
// tells you which destination you are in using the product's own language.
//
// There are exactly four destinations. Navigator is conversation-first, not a catalogue of AI
// features, so capability appears in context instead of as more rail entries.
//
// 只有四个一级入口。功能按上下文出现，不做"AI 功能目录"。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;

namespace Cyrene.Navigator.Windows.Controls;

public enum NavDestination
{
    Sessions,
    Activity,
    Workspace,
    Settings,
}

public sealed class CyreneNavigation : Grid
{
    private const double CollapsedWidth = 52;
    private const double ExpandedWidth = 224;

    private readonly List<NavRow> _rows = new();
    private readonly StackPanel _primary;
    private readonly StackPanel _secondary;
    private readonly Button _toggle;
    private FrameworkElement? _toggleText;
    private FrameworkElement? _footerBrandText;
    private bool _expanded = true;

    public event Action<NavDestination>? Selected;

    public NavDestination Current { get; private set; } = NavDestination.Sessions;

    public CyreneNavigation()
    {
        Width = ExpandedWidth;
        Background = Tk.FillSand;
        BorderBrush = Tk.Line;
        BorderThickness = Tk.Ln.Right;

        RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        RowDefinitions.Add(new RowDefinition { Height = Ui.Star() });
        RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });

        _toggle = BuildToggle();
        Children.Add(_toggle.At(0, 0));

        _primary = new StackPanel { Orientation = Orientation.Vertical, Spacing = 2, Margin = new Thickness(6, 4, 6, 0) };
        _primary.Children.Add(Add(NavDestination.Sessions, "\uE8BD", "Sessions", "Conversations and projects"));
        _primary.Children.Add(Add(NavDestination.Activity, "\uE9D9", "Activity", "Runs happening now"));
        _primary.Children.Add(Add(NavDestination.Workspace, "\uE950", "Workspace", "Models, nodes and usage"));
        Children.Add(_primary.At(0, 1));

        _secondary = new StackPanel { Orientation = Orientation.Vertical, Spacing = 2, Margin = new Thickness(6, 0, 6, 8) };
        _secondary.Children.Add(BuildFooterBrand());
        _secondary.Children.Add(Add(NavDestination.Settings, "\uE713", "Settings", "Appearance, account, tools"));
        Children.Add(_secondary.At(0, 2));

        Select(NavDestination.Sessions, notify: false);
    }

    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Wordmark plus rail collapse control. The wordmark carries a gradient-filled diamond, the
    /// smallest possible statement of the brand mark.
    /// </summary>
    private Button BuildToggle()
    {
        var mark = Ui.SolidDiamond(9);
        mark.Margin = new Thickness(2, 0, 0, 0);

        var word = new TextBlock
        {
            Text = "CYRENE",
            FontFamily = Tk.Ty.Display,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            CharacterSpacing = 180,
            Foreground = Tk.TextInk,
            VerticalAlignment = VerticalAlignment.Center,
        };

        var sub = new TextBlock
        {
            Text = "NAVIGATOR",
            FontFamily = Tk.Ty.Display,
            FontSize = 9.5,
            FontWeight = FontWeights.SemiBold,
            CharacterSpacing = 180,
            Foreground = Tk.Wash(Tk.Raw.Muted, 0.85),
        };

        var text = Ui.VStack(0, word, sub);
        text.VerticalAlignment = VerticalAlignment.Center;
        _toggleText = text;

        var row = Ui.HStack(Tk.Sp.S12, mark, text);
        row.Margin = new Thickness(Tk.Sp.S10, 0, 0, 0);

        var button = new Button
        {
            Content = row,
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            CornerRadius = Tk.Rad.Md,
            Padding = new Thickness(0, Tk.Sp.S8, 0, Tk.Sp.S8),
            Margin = new Thickness(4, 6, 4, Tk.Sp.S12),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Left,
        };
        button.Click += (_, _) => SetExpanded(!_expanded);
        ToolTipService.SetToolTip(button, "Collapse navigation");
        return button;
    }

    /// <summary>Workspace identity at the foot of the rail — always visible, never a menu.</summary>
    private FrameworkElement BuildFooterBrand()
    {
        var name = new TextBlock
        {
            Text = "Example Workspace",
            FontFamily = Tk.Ty.Text,
            FontSize = 12.5,
            Foreground = Tk.TextInk,
        };

        var role = Typo.Label("workspace · member", Tk.Wash(Tk.Raw.Muted, 0.9));

        var avatar = new Border
        {
            Width = 26,
            Height = 26,
            CornerRadius = Tk.Rad.Xs,
            Background = Tk.Edge,
            Child = new TextBlock
            {
                Text = "N",
                FontFamily = Tk.Ty.Display,
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                Foreground = Tk.TextOnInk,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            },
        };

        var texts = Ui.VStack(0, name, role);
        texts.VerticalAlignment = VerticalAlignment.Center;
        _footerBrandText = texts;

        var row = Ui.HStack(Tk.Sp.S10, avatar, texts);
        var host = new Border
        {
            Padding = new Thickness(Tk.Sp.S8, Tk.Sp.S8, Tk.Sp.S8, Tk.Sp.S8),
            CornerRadius = Tk.Rad.Md,
            Background = Tk.FillTransparent,
            Margin = new Thickness(0, Tk.Sp.S8, 0, Tk.Sp.S4),
            Child = row,
        };
        host.Interactive();
        host.ContextFlyout = BuildAccountMenu();
        ToolTipService.SetToolTip(host, "Example Workspace · configured principal");
        return host;
    }

    private static MenuFlyout BuildAccountMenu()
    {
        var flyout = new MenuFlyout();
        flyout.Items.Add(new MenuFlyoutItem { Text = "Switch workspace…", Icon = new FontIcon { Glyph = "\uE8AB" } });
        flyout.Items.Add(new MenuFlyoutItem { Text = "Account settings", Icon = new FontIcon { Glyph = "\uE77B" } });
        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(new MenuFlyoutItem { Text = "Sign out", Icon = new FontIcon { Glyph = "\uF3B1" } });
        return flyout;
    }

    private FrameworkElement Add(NavDestination destination, string glyph, string label, string tooltip)
    {
        var row = new NavRow(destination, glyph, label, tooltip);
        row.Invoked += () => Select(destination, notify: true);
        _rows.Add(row);
        return row;
    }

    public void Select(NavDestination destination, bool notify = true)
    {
        Current = destination;
        foreach (var row in _rows)
        {
            row.SetSelected(row.Destination == destination);
        }

        if (notify)
        {
            Selected?.Invoke(destination);
        }
    }

    public void SetExpanded(bool expanded)
    {
        _expanded = expanded;
        if (_toggleText is not null) _toggleText.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
        if (_footerBrandText is not null) _footerBrandText.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
        foreach (var row in _rows)
        {
            row.SetExpanded(expanded);
        }

        ToolTipService.SetToolTip(_toggle, expanded ? "Collapse navigation" : "Expand navigation");

        // The rail width is animated, and Width needs the dependent-animation opt-in.
        var story = new Storyboard();
        var animation = new DoubleAnimation
        {
            To = expanded ? ExpandedWidth : CollapsedWidth,
            Duration = Tk.Mo.Base,
            EasingFunction = Tk.Mo.EaseOut,
            EnableDependentAnimation = true,
        };
        Storyboard.SetTarget(animation, this);
        Storyboard.SetTargetProperty(animation, "Width");
        story.Children.Add(animation);
        Ui.PlayWhenLive(this, story, () => Width = expanded ? ExpandedWidth : CollapsedWidth);

        foreach (var child in _primary.Children)
        {
            if (child is NavRow navRow)
            {
                navRow.SetExpanded(expanded);
            }
        }

        _toggle.HorizontalContentAlignment = expanded ? HorizontalAlignment.Left : HorizontalAlignment.Center;
    }

    /// <summary>
    /// One rail entry. The interactive surface is a real <see cref="Button"/> so hover, pressed,
    /// keyboard activation, focus visuals and narrator support are the platform's, not
    /// re-implemented. Only the selection indicator is ours: a 2px brand-gradient bar.
    /// </summary>
    private sealed class NavRow : Grid
    {
        private readonly Border _indicator;
        private readonly Button _surface;
        private readonly TextBlock _glyph;
        private readonly TextBlock _label;
        private readonly string _tooltip;
        private bool _selected;

        public event Action? Invoked;

        public NavDestination Destination { get; }

        public NavRow(NavDestination destination, string glyph, string label, string tooltip)
        {
            Destination = destination;
            _tooltip = tooltip;

            _glyph = Typo.Glyph(glyph, 16, Tk.TextSlate);
            _glyph.Width = 28;

            _label = new TextBlock
            {
                Text = label,
                FontFamily = Tk.Ty.Text,
                FontSize = 13.5,
                Foreground = Tk.TextSlate,
                VerticalAlignment = VerticalAlignment.Center,
            };

            var row = Ui.HStack(Tk.Sp.S10, _glyph, _label);
            row.Margin = new Thickness(4, 0, 0, 0);

            _surface = new Button
            {
                Content = row,
                Background = Tk.FillTransparent,
                BorderThickness = Tk.Ln.None,
                CornerRadius = Tk.Rad.Md,
                Height = 38,
                Padding = new Thickness(0),
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
            };
            _surface.PointerEntered += (_, _) =>
            {
                if (!_selected) _surface.Background = Tk.FillHover;
            };
            _surface.PointerExited += (_, _) =>
            {
                _surface.Background = _selected ? Tk.FillSelected : Tk.FillTransparent;
            };
            _surface.Click += (_, _) => Invoked?.Invoke();

            _indicator = new Border
            {
                Width = Tk.Ln.Indicator,
                Height = 18,
                CornerRadius = new CornerRadius(1),
                Background = Tk.TraceLive,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(-4, 0, 0, 0),
                Opacity = 0,
                IsHitTestVisible = false,
            };

            Children.Add(_surface);
            Children.Add(_indicator);

            ToolTipService.SetToolTip(_surface, label + " — " + tooltip);
        }

        public void SetSelected(bool selected)
        {
            _selected = selected;
            _indicator.Opacity = selected ? 1 : 0;
            _surface.Background = selected ? Tk.FillSelected : Tk.FillTransparent;
            _glyph.Foreground = selected ? Tk.TextInk : Tk.TextSlate;
            _label.Foreground = selected ? Tk.TextInk : Tk.TextSlate;
            _label.FontWeight = selected ? FontWeights.SemiBold : FontWeights.Normal;
        }

        public void SetExpanded(bool expanded)
        {
            _label.Visibility = expanded ? Visibility.Visible : Visibility.Collapsed;
            _surface.HorizontalContentAlignment = expanded ? HorizontalAlignment.Left : HorizontalAlignment.Center;
            ToolTipService.SetToolTip(_surface, expanded ? _tooltip : _label.Text + " — " + _tooltip);
            SetSelected(_selected);
        }
    }
}
