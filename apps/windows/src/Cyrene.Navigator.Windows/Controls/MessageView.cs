// Controls/MessageView.cs
//
// Turn rendering / 消息渲染。
//
// The most consequential decision in the whole design is here: assistant turns are **documents,
// not bubbles**. They sit directly on the paper canvas at a single reading measure, with no
// container, no avatar and no alignment games. User turns get a recessed sand card, so the two
// voices are distinguished by surface rather than by side.
//
// The result reads like a working document with your own notes interleaved, which is what a
// long agent session actually is — and it is the main reason this does not look like a web chat
// client.
//
// Assistant 消息不做气泡：直接排在纸面上、单栏、固定行宽。用户消息用凹陷的 sand 卡片区分。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Core.Text;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;

using WinFontStyle = Windows.UI.Text.FontStyle;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class MessageView : Grid
{
    /// <summary>Reading measure for prose. Roughly 78 characters at 14px Segoe UI Variable.</summary>
    public const double ProseWidth = 780;

    private readonly TurnItem _item;
    private readonly MarkdownView _body;
    private readonly Border? _liveEdge;
    private readonly TextBlock? _liveLabel;

    public MessageView(TurnItem item)
    {
        _item = item;

        var stack = new StackPanel { Orientation = Orientation.Vertical, Spacing = Tk.Sp.S6 };
        var eyebrow = BuildEyebrow(out _liveLabel);
        stack.Children.Add(eyebrow);

        if (item.Role == TurnRole.Assistant && !string.IsNullOrWhiteSpace(item.ThoughtSummary))
        {
            stack.Children.Add(BuildThought(item.ThoughtSummary!));
        }

        // Settled turns render from the cached block list; only the streaming tail is parsed
        // from text, and only for its own trailing block.
        if (item.IsStreaming)
        {
            _body = new MarkdownView(item.Markdown, codeMaxHeight: 380);
        }
        else
        {
            if (item.ParsedCache is not IReadOnlyList<MdBlock> blocks)
            {
                blocks = Core.Text.Markdown.Parse(item.Markdown);
                item.ParsedCache = blocks;
            }

            _body = new MarkdownView(blocks, codeMaxHeight: 380);
        }

        if (item.Role == TurnRole.User)
        {
            var card = new Border
            {
                Background = Tk.FillSandDeep,
                BorderBrush = Tk.Line,
                BorderThickness = Tk.Ln.Hair,
                CornerRadius = Tk.Rad.Lg,
                Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12),
                MaxWidth = ProseWidth,
                HorizontalAlignment = HorizontalAlignment.Left,
                Child = _body,
            };
            stack.Children.Add(card);
        }
        else if (item.IsStreaming)
        {
            // A live turn is marked by a 2px gradient edge along its left side — the trace
            // reaching into the text — instead of a blinking caret glued to the last glyph.
            var row = new Grid { MaxWidth = ProseWidth + Tk.Sp.S12, HorizontalAlignment = HorizontalAlignment.Left };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(Tk.Sp.S12) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

            _liveEdge = new Border
            {
                Width = 2,
                Background = Tk.TraceLive,
                CornerRadius = new CornerRadius(1),
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Stretch,
            };
            Ui.Breathe(_liveEdge, 0.5, 1);
            row.Children.Add(_liveEdge.At(0));
            row.Children.Add(_body.At(1));
            stack.Children.Add(row);
        }
        else
        {
            _body.MaxWidth = ProseWidth;
            _body.HorizontalAlignment = HorizontalAlignment.Left;
            stack.Children.Add(_body);
        }

        Children.Add(stack);
        ContextFlyout = BuildContextMenu();
    }

    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// The turn's identity line. Putting the model name here — in brand orchid, on every single
    /// assistant turn — means "which model said this" never needs to be looked up, which matters
    /// in a session where the model changes.
    /// </summary>
    private FrameworkElement BuildEyebrow(out TextBlock? liveLabel)
    {
        liveLabel = null;
        var row = Ui.HStack(Tk.Sp.S8);

        if (_item.Role == TurnRole.User)
        {
            row.Children.Add(Typo.Eyebrow("you", Tk.Wash(Tk.Raw.Slate, 0.85)));
        }
        else
        {
            row.Children.Add(Typo.Eyebrow("cyrene", Tk.Wash(Tk.Raw.Slate, 0.85)));
            if (!string.IsNullOrWhiteSpace(_item.ModelLabel))
            {
                row.Children.Add(Dot());
                row.Children.Add(Typo.Label(_item.ModelLabel, Tk.Orchid));
            }
        }

        row.Children.Add(Dot());
        row.Children.Add(Typo.Label(Ui.Clock(_item.At), Tk.Wash(Tk.Raw.Muted, 0.8)));

        if (_item.IsStreaming)
        {
            row.Children.Add(Dot());
            liveLabel = Typo.Label("responding", Tk.Coral);
            Ui.Breathe(liveLabel, 0.45, 1);
            row.Children.Add(liveLabel);
        }

        return row;
    }

    private static FrameworkElement Dot() => new Border
    {
        Width = 2,
        Height = 2,
        CornerRadius = new CornerRadius(1),
        Background = Tk.Wash(Tk.Raw.Muted, 0.5),
        VerticalAlignment = VerticalAlignment.Center,
    };

    /// <summary>
    /// Reasoning summary as one quiet line. Never a wall of chain-of-thought: the useful signal
    /// is "what was it working on", and that fits on a line.
    /// </summary>
    private static FrameworkElement BuildThought(string summary)
    {
        var text = Typo.Meta(summary, Tk.TextMuted);
        text.FontStyle = WinFontStyle.Italic;
        text.TextWrapping = TextWrapping.Wrap;
        text.MaxWidth = ProseWidth - 40;

        var row = Ui.HStack(Tk.Sp.S8,
            Ui.Diamond(Tk.Wash(Tk.Raw.Muted, 0.6), Tk.FillPaper, 5),
            Typo.Label("thought", Tk.Wash(Tk.Raw.Muted, 0.7)),
            text);
        row.Margin = new Thickness(0, 0, 0, Tk.Sp.S2);
        return row;
    }

    private MenuFlyout BuildContextMenu()
    {
        var flyout = new MenuFlyout();

        var copy = new MenuFlyoutItem { Text = "Copy message", Icon = new FontIcon { Glyph = "\uE8C8" } };
        copy.Click += (_, _) =>
        {
            try
            {
                var package = new DataPackage();
                package.SetText(_item.Markdown);
                Clipboard.SetContent(package);
            }
            catch (Exception)
            {
                // Ignored: transient clipboard ownership.
            }
        };
        flyout.Items.Add(copy);

        if (_item.Role == TurnRole.User)
        {
            flyout.Items.Add(new MenuFlyoutItem { Text = "Edit and resend", Icon = new FontIcon { Glyph = "\uE70F" } });
            flyout.Items.Add(new MenuFlyoutItem { Text = "Branch from here", Icon = new FontIcon { Glyph = "\uE8AB" } });
        }
        else
        {
            flyout.Items.Add(new MenuFlyoutItem { Text = "Retry with another model", Icon = new FontIcon { Glyph = "\uE72C" } });
            flyout.Items.Add(new MenuFlyoutItem { Text = "Save as artifact", Icon = new FontIcon { Glyph = "\uE74E" } });
        }

        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(new MenuFlyoutItem { Text = "Select text", Icon = new FontIcon { Glyph = "\uE8B3" } });

        return flyout;
    }

    // -----------------------------------------------------------------------------------------
    // Streaming
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Applies newly arrived text. Only the blocks that actually changed are rebuilt, so a long
    /// answer does not re-layout from the top on every chunk.
    /// </summary>
    public void UpdateStreaming(string markdown) => _body.UpdateStreaming(markdown);

    /// <summary>Removes the live treatment once the turn is complete.</summary>
    public void FinishStreaming()
    {
        _item.IsStreaming = false;

        if (_liveEdge is not null)
        {
            _liveEdge.Background = Tk.FillTransparent;
        }

        if (_liveLabel is not null)
        {
            _liveLabel.Visibility = Visibility.Collapsed;
        }
    }
}

/// <summary>Day separators and context notices — the timeline's quietest rows.</summary>
public static class TimelineMarks
{
    /// <summary>
    /// Date separator. A tracked label centred on a hairline, matching the horizon rule so the
    /// timeline's punctuation and the page's punctuation are the same gesture.
    /// </summary>
    public static FrameworkElement Divider(string label)
    {
        var row = new Grid { Margin = new Thickness(0, Tk.Sp.S24, 0, Tk.Sp.S16), ColumnSpacing = Tk.Sp.S12 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        row.Children.Add(Typo.Eyebrow(label, Tk.Wash(Tk.Raw.Muted, 0.9)).At(0));

        var line = new Border
        {
            Height = 1,
            Background = Tk.Line,
            VerticalAlignment = VerticalAlignment.Center,
        };
        row.Children.Add(line.At(1));
        return row;
    }

    /// <summary>
    /// Context notice: a model switch, a fallback, a permission change. These are facts the user
    /// needs but did not ask for, so they get the least ink of anything on the timeline.
    /// </summary>
    public static FrameworkElement Notice(NoticeItem item)
    {
        var stack = Ui.VStack(2, Typo.Meta(item.Text, Tk.TextSlate));

        if (!string.IsNullOrWhiteSpace(item.Detail))
        {
            var detail = Typo.Meta(item.Detail!, Tk.Wash(Tk.Raw.Muted, 0.85));
            detail.TextWrapping = TextWrapping.Wrap;
            detail.MaxWidth = 560;
            stack.Children.Add(detail);
        }

        var row = Ui.HStack(Tk.Sp.S10,
            Ui.Diamond(Tk.Wash(Tk.Raw.Muted, 0.55), Tk.FillPaper, 5),
            stack);
        row.VerticalAlignment = VerticalAlignment.Top;
        row.Margin = new Thickness(0, Tk.Sp.S2, 0, Tk.Sp.S2);
        return row;
    }
}
