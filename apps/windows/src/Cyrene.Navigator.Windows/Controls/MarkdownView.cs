// Controls/MarkdownView.cs
//
// Markdown renderer / Markdown 渲染。
//
// Assistant turns are documents, not chat bubbles, so this reads like a typeset page: a single
// measure, generous leading, hairline tables, and headings marked with the brand's gradient
// diamond instead of rules or boxes.
//
// Streaming is handled incrementally. <see cref="UpdateStreaming"/> reparses the text but only
// rebuilds blocks whose content actually changed — in practice the final block. That is the
// difference between a transcript that re-lays-out on every token and one that does not.
//
// 长文本阅读优先：单栏、固定行高、克制的层级；表格用发丝线而不是描边盒子。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core.Text;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;

using WinFontStyle = Windows.UI.Text.FontStyle;
using WinFontWeight = Windows.UI.Text.FontWeight;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class MarkdownView : StackPanel
{
    private readonly double _codeMaxHeight;
    private readonly bool _compact;
    private List<string> _signatures = new();

    public MarkdownView(string markdown, double codeMaxHeight = 360, bool compact = false)
        : this(Markdown.Parse(markdown), codeMaxHeight, compact)
    {
    }

    /// <summary>
    /// Renders an already-parsed document. This is the overload the timeline uses: blocks are
    /// parsed once and cached on the message, so scrolling back through a long transcript never
    /// re-parses markdown even though the row views are rebuilt on recycle.
    /// </summary>
    public MarkdownView(IReadOnlyList<MdBlock> blocks, double codeMaxHeight = 360, bool compact = false)
    {
        Orientation = Orientation.Vertical;
        _codeMaxHeight = codeMaxHeight;
        _compact = compact;
        Render(blocks);
    }

    /// <summary>
    /// Re-renders after new tokens arrive, replacing only the blocks that changed. Returns the
    /// number of blocks rebuilt, which is normally one.
    /// </summary>
    public int UpdateStreaming(string markdown)
    {
        var blocks = Markdown.Parse(markdown);
        var signatures = new List<string>(blocks.Count);
        foreach (var block in blocks)
        {
            signatures.Add(Signature(block));
        }

        // Guard: block-to-child mapping must be 1:1 for incremental replacement to be valid.
        if (Children.Count != _signatures.Count)
        {
            Render(blocks);
            return blocks.Count;
        }

        // Find the first block that differs; everything before it is already correct on screen.
        var firstChanged = 0;
        while (firstChanged < _signatures.Count
               && firstChanged < signatures.Count
               && _signatures[firstChanged] == signatures[firstChanged])
        {
            firstChanged++;
        }

        while (Children.Count > firstChanged)
        {
            Children.RemoveAt(Children.Count - 1);
        }

        for (var i = firstChanged; i < blocks.Count; i++)
        {
            var element = BuildBlock(blocks[i], i == 0);
            if (element is not null)
            {
                Children.Add(element);
            }
        }

        var rebuilt = blocks.Count - firstChanged;
        _signatures = signatures;
        return rebuilt;
    }

    private void Render(IReadOnlyList<MdBlock> blocks)
    {
        Children.Clear();
        _signatures = new List<string>(blocks.Count);
        for (var i = 0; i < blocks.Count; i++)
        {
            var element = BuildBlock(blocks[i], i == 0);
            if (element is null)
            {
                continue;
            }

            _signatures.Add(Signature(blocks[i]));
            Children.Add(element);
        }
    }

    /// <summary>Cheap identity for change detection during streaming.</summary>
    private static string Signature(MdBlock block)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append((int)block.Kind).Append('|').Append(block.Level).Append('|').Append(block.Language).Append('|');
        sb.Append(block.Code.Length).Append('|');
        sb.Append(Markdown.Flatten(block.Inlines));
        foreach (var item in block.Items)
        {
            sb.Append('\u001f').Append(Markdown.Flatten(item.Inlines));
        }

        sb.Append('|').Append(block.TableRows.Count);
        return sb.ToString();
    }

    // -----------------------------------------------------------------------------------------
    // Block rendering
    // -----------------------------------------------------------------------------------------

    private UIElement? BuildBlock(MdBlock block, bool isFirst)
    {
        var topGap = isFirst ? 0 : (_compact ? Tk.Sp.S6 : Tk.Sp.S12);

        switch (block.Kind)
        {
            case MdBlockKind.Heading:
                return BuildHeading(block, isFirst);

            case MdBlockKind.Paragraph:
            {
                var text = BuildProse(block.Inlines, Tk.Ty.Body, Tk.Ty.LineBody, Tk.TextInk);
                text.Margin = new Thickness(0, topGap, 0, 0);
                return text;
            }

            case MdBlockKind.Bullets:
            case MdBlockKind.Numbers:
                return BuildList(block, topGap);

            case MdBlockKind.Code:
            {
                var code = new CodeBlockView(block.Code, block.Language, _codeMaxHeight)
                {
                    Margin = new Thickness(0, isFirst ? 0 : Tk.Sp.S16, 0, Tk.Sp.S4),
                };
                return code;
            }

            case MdBlockKind.Quote:
                return BuildQuote(block, topGap);

            case MdBlockKind.Rule:
                return Ui.Divider(Tk.Sp.S20, Tk.Sp.S16);

            case MdBlockKind.Table:
                return BuildTable(block, isFirst);

            default:
                return null;
        }
    }

    /// <summary>
    /// Headings carry a gradient diamond in the left margin rather than a rule or a weight jump.
    /// It is the brand's `.domain h3:before`, and it gives long messages a scannable spine of
    /// its own without adding another border to the page.
    /// </summary>
    private FrameworkElement BuildHeading(MdBlock block, bool isFirst)
    {
        var size = block.Level switch
        {
            1 => 19.0,
            2 => 16.5,
            3 => 14.5,
            _ => 14.0,
        };

        var text = BuildProse(block.Inlines, size, size * 1.32, Tk.TextInk, FontWeights.SemiBold, Tk.Ty.Display);
        text.CharacterSpacing = Tk.Ty.TrackDisplay;

        if (block.Level > 2)
        {
            text.Margin = new Thickness(0, isFirst ? 0 : Tk.Sp.S16, 0, Tk.Sp.S2);
            return text;
        }

        var row = new Grid { Margin = new Thickness(0, isFirst ? 0 : Tk.Sp.S24, 0, Tk.Sp.S4) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(18) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        var mark = Ui.SolidDiamond(7);
        mark.HorizontalAlignment = HorizontalAlignment.Left;
        mark.VerticalAlignment = VerticalAlignment.Top;
        mark.Margin = new Thickness(0, size * 0.44, 0, 0);
        row.Children.Add(mark.At(0));
        row.Children.Add(text.At(1));
        return row;
    }

    private FrameworkElement BuildList(MdBlock block, double topGap)
    {
        var stack = new StackPanel
        {
            Orientation = Orientation.Vertical,
            Spacing = Tk.Sp.S6,
            Margin = new Thickness(0, topGap, 0, Tk.Sp.S2),
        };

        foreach (var item in block.Items)
        {
            var row = new Grid { Margin = new Thickness(item.Depth * 18, 0, 0, 0) };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(block.Kind == MdBlockKind.Numbers ? 24 : 18) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

            FrameworkElement marker;
            if (block.Kind == MdBlockKind.Numbers)
            {
                marker = new TextBlock
                {
                    Text = item.Ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    FontFamily = Tk.Ty.Display,
                    FontSize = 12,
                    FontWeight = FontWeights.SemiBold,
                    CharacterSpacing = Tk.Ty.TrackLabel,
                    Foreground = Tk.Orchid,
                    Margin = new Thickness(0, 4, 0, 0),
                };
            }
            else if (item.Checked.HasValue)
            {
                marker = item.Checked.Value
                    ? Ui.Diamond(Tk.Success, Tk.Success, 6)
                    : Ui.Diamond(Tk.LineStrong, Tk.FillPaper, 6);
                marker.VerticalAlignment = VerticalAlignment.Top;
                marker.Margin = new Thickness(0, 7, 0, 0);
            }
            else
            {
                marker = Ui.Diamond(item.Depth > 0 ? Tk.LineStrong : Tk.Wash(Tk.Raw.Orchid, 0.85), Tk.FillPaper, item.Depth > 0 ? 4 : 5);
                marker.VerticalAlignment = VerticalAlignment.Top;
                marker.Margin = new Thickness(0, item.Depth > 0 ? 8 : 7.5, 0, 0);
            }

            marker.HorizontalAlignment = HorizontalAlignment.Left;
            row.Children.Add(marker.At(0));
            row.Children.Add(BuildProse(item.Inlines, Tk.Ty.Body, Tk.Ty.LineBody, Tk.TextInk).At(1));
            stack.Children.Add(row);
        }

        return stack;
    }

    /// <summary>
    /// Block quote: a 2px vertical brand gradient in place of the usual grey bar. The gradient
    /// line is the product's connective tissue, so using it here reads as continuity rather than
    /// as a new decoration.
    /// </summary>
    private FrameworkElement BuildQuote(MdBlock block, double topGap)
    {
        var row = new Grid { Margin = new Thickness(0, topGap + Tk.Sp.S4, 0, Tk.Sp.S4) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(Tk.Sp.S16) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        var bar = new Border
        {
            Width = 2,
            Background = Tk.TraceLive,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Stretch,
            CornerRadius = new CornerRadius(1),
        };
        row.Children.Add(bar.At(0));

        var text = BuildProse(block.Inlines, Tk.Ty.BodyLead, Tk.Ty.LineLead, Tk.TextSlate);
        text.FontStyle = WinFontStyle.Italic;
        text.Margin = new Thickness(0, 0, 0, 0);
        row.Children.Add(text.At(1));
        return row;
    }

    /// <summary>
    /// Tables are hairline sheets, not bordered boxes: tracked uppercase headers, one hairline
    /// between rows, and a warm hover wash. Directly borrowed from the brand's research list.
    /// </summary>
    private FrameworkElement BuildTable(MdBlock block, bool isFirst)
    {
        var columns = Math.Max(1, block.TableHeader.Count);
        var grid = new Grid
        {
            Margin = new Thickness(0, isFirst ? 0 : Tk.Sp.S16, 0, Tk.Sp.S8),
            BorderBrush = Tk.Line,
            BorderThickness = new Thickness(0, 1, 0, 1),
        };

        for (var c = 0; c < columns; c++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = c == 0 ? Ui.Star(1.3) : Ui.Star() });
        }

        grid.RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        for (var r = 0; r < block.TableRows.Count; r++)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        }

        for (var c = 0; c < columns; c++)
        {
            var label = c < block.TableHeader.Count
                ? Markdown.Flatten(block.TableHeader[c].Inlines)
                : string.Empty;
            var cell = Typo.Label(label, Tk.TextMuted);
            cell.Margin = new Thickness(c == 0 ? 0 : Tk.Sp.S12, Tk.Sp.S10, Tk.Sp.S12, Tk.Sp.S8);
            cell.TextWrapping = TextWrapping.Wrap;
            grid.Children.Add(cell.At(c));
        }

        for (var r = 0; r < block.TableRows.Count; r++)
        {
            var row = block.TableRows[r];

            // A full-width hover wash, drawn beneath the cells of this row.
            var wash = new Border
            {
                Background = Tk.FillTransparent,
                BorderBrush = Tk.Line,
                BorderThickness = Tk.Ln.Top,
            };
            Grid.SetRow(wash, r + 1);
            Grid.SetColumnSpan(wash, columns);
            wash.Interactive(Tk.FillSandDeep, Tk.FillTransparent);
            grid.Children.Add(wash);

            for (var c = 0; c < columns; c++)
            {
                var inlines = c < row.Count ? row[c].Inlines : Array.Empty<MdInline>();
                var cell = BuildProse(inlines, Tk.Ty.Meta, 19, c == 0 ? Tk.TextInk : Tk.TextSlate);
                cell.Margin = new Thickness(c == 0 ? 0 : Tk.Sp.S12, Tk.Sp.S8, Tk.Sp.S12, Tk.Sp.S8);
                cell.IsHitTestVisible = false;
                grid.Children.Add(cell.At(c, r + 1));
            }
        }

        return grid;
    }

    // -----------------------------------------------------------------------------------------
    // Inline rendering
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Builds one TextBlock for a run of inlines. Inline code is set in the mono face and the
    /// brand's code hue rather than in a boxed pill — a pill breaks the leading of a paragraph
    /// that people read for hours.
    /// </summary>
    private static TextBlock BuildProse(
        IReadOnlyList<MdInline> inlines,
        double size,
        double lineHeight,
        Brush foreground,
        WinFontWeight? weight = null,
        FontFamily? family = null)
    {
        var text = new TextBlock
        {
            FontFamily = family ?? Tk.Ty.Text,
            FontSize = size,
            LineHeight = lineHeight,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            Foreground = foreground,
            TextWrapping = TextWrapping.Wrap,
            IsTextSelectionEnabled = true,
        };

        if (weight.HasValue)
        {
            text.FontWeight = weight.Value;
        }

        foreach (var inline in inlines)
        {
            switch (inline.Kind)
            {
                case MdInlineKind.Strong:
                    text.Inlines.Add(new Run { Text = inline.Text, FontWeight = FontWeights.SemiBold });
                    break;

                case MdInlineKind.Emphasis:
                    text.Inlines.Add(new Run { Text = inline.Text, FontStyle = WinFontStyle.Italic });
                    break;

                case MdInlineKind.Code:
                    text.Inlines.Add(new Run
                    {
                        Text = inline.Text,
                        FontFamily = Tk.Ty.Mono,
                        FontSize = size - 1.2,
                        Foreground = Tk.SynInline,
                    });
                    break;

                case MdInlineKind.Link:
                {
                    var link = new Hyperlink { UnderlineStyle = UnderlineStyle.None };
                    link.Inlines.Add(new Run { Text = inline.Text, Foreground = Tk.Orchid });
                    if (!string.IsNullOrWhiteSpace(inline.Href)
                        && Uri.TryCreate(inline.Href, UriKind.Absolute, out var uri))
                    {
                        link.NavigateUri = uri;
                    }

                    text.Inlines.Add(link);
                    break;
                }

                default:
                    text.Inlines.Add(new Run { Text = inline.Text });
                    break;
            }
        }

        return text;
    }
}
