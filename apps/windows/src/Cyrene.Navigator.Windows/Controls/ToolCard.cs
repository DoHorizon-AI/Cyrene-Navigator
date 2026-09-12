// Controls/ToolCard.cs
//
// Tool invocation card / 工具调用卡片。
//
// Three rules the design follows:
//
//   1. Collapsed by default, always. A tool call's value in a transcript is its *conclusion*;
//      the payload is evidence you go and fetch. Expanding is one click or one Enter.
//   2. Two lines when collapsed: what it acted on, and what happened. Never three.
//   3. Hue encodes locality. Brand hues mean the call stayed on this machine or in the
//      workspace; ochre means it left. "Where did this run" should never require reading.
//
// 折叠态只有两行：作用对象 + 结论。展开才给证据。

using System;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Core.Text;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class ToolCard : Grid
{
    private readonly ToolItem _item;
    private readonly TextBlock _chevron;
    private readonly Border _body;
    private readonly Border _card;
    private readonly INavigatorUiData _data;
    private bool _expanded;

    public ToolCard(ToolItem item, INavigatorUiData data)
    {
        _item = item;
        _data = data;

        var accent = AccentFor(item);
        var stack = new StackPanel { Orientation = Orientation.Vertical };

        _chevron = Typo.Glyph("\uE70D", 10, Tk.Wash(Tk.Raw.Muted, 0.8));
        _chevron.RenderTransform = new RotateTransform { Angle = 0 };
        _chevron.RenderTransformOrigin = new Point(0.5, 0.5);

        stack.Children.Add(BuildHeader(accent));

        _body = BuildBody();
        _body.Visibility = Visibility.Collapsed;
        stack.Children.Add(_body);

        _card = new Border
        {
            Background = Tk.FillPaper,
            BorderBrush = item.Outcome == ToolOutcome.Failed ? Tk.Wash(Tk.Raw.Danger, 0.35) : Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Md,
            Child = stack,
        };
        var card = _card;

        if (item.Outcome == ToolOutcome.Running)
        {
            // A running tool gets a hairline gradient along its top edge — the trace continuing
            // into the card — rather than a spinner.
            var running = new Border
            {
                Height = 1.5,
                Background = Tk.Horizon,
                VerticalAlignment = VerticalAlignment.Top,
                HorizontalAlignment = HorizontalAlignment.Stretch,
                Margin = new Thickness(1, 0, 1, 0),
                CornerRadius = new CornerRadius(1),
            };
            Ui.Breathe(running, 0.35, 1);
            Children.Add(card);
            Children.Add(running);
        }
        else
        {
            Children.Add(card);
        }

        ContextFlyout = BuildContextMenu();

        if (item.StartExpanded)
        {
            Toggle();
        }
    }

    // -----------------------------------------------------------------------------------------

    private Button BuildHeader(Brush accent)
    {
        var top = new Grid { ColumnSpacing = Tk.Sp.S10 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(16) });

        top.Children.Add(Ui.KindChip(_data.ToolLabel(_item.Kind), accent).At(0));

        var target = Typo.Mono(_item.Target, Tk.Wash(Tk.Raw.Ink, 0.86));
        target.TextTrimming = TextTrimming.CharacterEllipsis;
        target.VerticalAlignment = VerticalAlignment.Center;
        top.Children.Add(target.At(1));

        top.Children.Add(BuildStatus().At(2));

        top.Children.Add(_chevron.At(3));

        var bottom = new Grid { Margin = new Thickness(0, 3, 0, 0), ColumnSpacing = Tk.Sp.S12 };
        bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        bottom.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        var summary = Typo.Meta(
            _item.Summary,
            _item.Outcome == ToolOutcome.Failed ? Tk.Danger : Tk.TextSlate);
        summary.TextWrapping = TextWrapping.NoWrap;
        bottom.Children.Add(summary.At(0));

        var origin = Typo.Label(_item.Origin, Tk.Wash(Tk.Raw.Muted, 0.75));
        origin.HorizontalAlignment = HorizontalAlignment.Right;
        origin.Margin = new Thickness(0, 0, Tk.Sp.S16, 0);
        bottom.Children.Add(origin.At(1));

        var content = Ui.VStack(0, top, bottom);

        var button = new Button
        {
            Content = content,
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            CornerRadius = Tk.Rad.Md,
            Padding = new Thickness(Tk.Sp.S12, Tk.Sp.S10, Tk.Sp.S10, Tk.Sp.S10),
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        button.PointerEntered += (_, _) =>
        {
            if (_item.Outcome != ToolOutcome.Failed)
            {
                _card.BorderBrush = Tk.LineStrong;
            }
        };
        button.PointerExited += (_, _) =>
        {
            if (_item.Outcome != ToolOutcome.Failed)
            {
                _card.BorderBrush = Tk.Line;
            }
        };
        button.Click += (_, _) => Toggle();
        ToolTipService.SetToolTip(button, _item.Name + "  ·  " + _item.Target);
        return button;
    }

    private FrameworkElement BuildStatus()
    {
        switch (_item.Outcome)
        {
            case ToolOutcome.Running:
            {
                var label = Typo.Label("running", Tk.Coral);
                Ui.Breathe(label, 0.5, 1);
                return Ui.HStack(6, label, Typo.Mono(Ui.Duration(_item.Duration), Tk.TextMuted, 11.5));
            }

            case ToolOutcome.Failed:
                return Ui.HStack(6,
                    Ui.Diamond(Tk.Danger, Tk.Danger, 6),
                    Typo.Label("failed", Tk.Danger),
                    Typo.Mono(Ui.Duration(_item.Duration), Tk.Wash(Tk.Raw.Danger, 0.75), 11.5));

            case ToolOutcome.Denied:
                return Typo.Label("declined", Tk.TextMuted);

            case ToolOutcome.Skipped:
                return Typo.Label("skipped", Tk.TextMuted);

            default:
                return Typo.Mono(Ui.Duration(_item.Duration), Tk.Wash(Tk.Raw.Muted, 0.9), 11.5);
        }
    }

    private Border BuildBody()
    {
        var stack = new StackPanel
        {
            Orientation = Orientation.Vertical,
            Spacing = Tk.Sp.S10,
            Margin = new Thickness(Tk.Sp.S12, Tk.Sp.S12, Tk.Sp.S12, Tk.Sp.S12),
        };

        if (!string.IsNullOrWhiteSpace(_item.Request))
        {
            stack.Children.Add(Typo.Eyebrow("request"));
            stack.Children.Add(new CodeBlockView(
                _item.Request,
                _item.Kind is ToolKind.Shell or ToolKind.Test ? "bash" : "json",
                maxHeight: 160,
                showHeader: false,
                showLineNumbers: false));
        }

        if (!string.IsNullOrWhiteSpace(_item.Response))
        {
            var head = new Grid();
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
            head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
            head.Children.Add(Typo.Eyebrow(_item.Outcome == ToolOutcome.Failed ? "failure detail" : "response").At(0));
            head.Children.Add(Typo.Label(_item.ResponseLanguage, Tk.Wash(Tk.Raw.Muted, 0.7)).At(1));
            stack.Children.Add(head);

            // Tool responses are the largest text in a transcript, so the token stream is cached
            // on the item and survives container recycling.
            if (_item.ResponseTokenCache is not TokenizedCode tokens)
            {
                tokens = CodeTokenizer.Tokenize(_item.Response, _item.ResponseLanguage);
                _item.ResponseTokenCache = tokens;
            }

            stack.Children.Add(new CodeBlockView(
                _item.Response,
                _item.ResponseLanguage,
                maxHeight: 260,
                showHeader: false,
                showLineNumbers: _item.ResponseLanguage != "bash",
                cached: tokens));
        }

        return new Border
        {
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
            Background = Tk.Wash(Tk.Raw.SandDeep, 0.5),
            Child = stack,
        };
    }

    /// <summary>Native Windows context menu. Right-click and Shift+F10 both work for free.</summary>
    private MenuFlyout BuildContextMenu()
    {
        var flyout = new MenuFlyout();

        var expand = new MenuFlyoutItem { Icon = new FontIcon { Glyph = "\uE70D" } };
        expand.Click += (_, _) => Toggle();

        // Resolved on open so the label matches the card's current state.
        flyout.Opening += (_, _) => expand.Text = _expanded ? "Collapse" : "Expand";
        flyout.Items.Add(expand);

        var copyTarget = new MenuFlyoutItem { Text = "Copy target", Icon = new FontIcon { Glyph = "\uE8C8" } };
        copyTarget.Click += (_, _) => CopyToClipboard(_item.Target);
        flyout.Items.Add(copyTarget);

        var copyResponse = new MenuFlyoutItem { Text = "Copy response", Icon = new FontIcon { Glyph = "\uE8C8" } };
        copyResponse.Click += (_, _) => CopyToClipboard(_item.Response);
        flyout.Items.Add(copyResponse);

        flyout.Items.Add(new MenuFlyoutSeparator());

        var rerun = new MenuFlyoutItem { Text = "Run again", Icon = new FontIcon { Glyph = "\uE72C" } };
        flyout.Items.Add(rerun);

        var reveal = new MenuFlyoutItem { Text = "Show in run trace", Icon = new FontIcon { Glyph = "\uE8A7" } };
        flyout.Items.Add(reveal);

        return flyout;
    }

    private static void CopyToClipboard(string text)
    {
        try
        {
            var package = new DataPackage();
            package.SetText(text ?? string.Empty);
            Clipboard.SetContent(package);
        }
        catch (Exception)
        {
            // Nothing actionable — the clipboard is owned by another process for a moment.
        }
    }

    private void Toggle()
    {
        _expanded = !_expanded;
        _item.StartExpanded = _expanded;
        _body.Visibility = _expanded ? Visibility.Visible : Visibility.Collapsed;

        if (_expanded)
        {
            Ui.FadeIn(_body);
        }

        var angle = _expanded ? 180 : 0;
        var story = new Storyboard();
        var spin = new DoubleAnimation
        {
            To = angle,
            Duration = Tk.Mo.Base,
            EasingFunction = Tk.Mo.EaseOut,
        };
        Storyboard.SetTarget(spin, _chevron);
        Storyboard.SetTargetProperty(spin, "(UIElement.RenderTransform).(RotateTransform.Angle)");
        story.Children.Add(spin);

        // Toggle() also runs from the constructor for cards that start expanded, when the
        // chevron is not yet in the tree.
        Ui.PlayWhenLive(_chevron, story, () =>
        {
            if (_chevron.RenderTransform is RotateTransform rotate)
            {
                rotate.Angle = angle;
            }
        });
    }

    /// <summary>
    /// Hue by locality: brand hues stayed inside, ochre left the machine, green is a test.
    /// </summary>
    public static Brush AccentFor(ToolItem item) => item.Kind switch
    {
        ToolKind.ReadFile => Tk.Orchid,
        ToolKind.Search => Tk.Orchid,
        ToolKind.EditFile => Tk.Rose,
        ToolKind.NativeTool => Tk.Coral,
        ToolKind.Shell => Tk.Wash(Tk.Raw.Slate, 0.9),
        ToolKind.Test => Tk.Success,
        _ => Tk.Warn,
    };
}
