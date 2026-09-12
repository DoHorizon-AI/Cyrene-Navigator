// Controls/CodeBlockView.cs
//
// Code block / 代码块。
//
// Performance is part of the design here, not an afterthought. Three decisions matter:
//
//   1. The whole block is *two* TextBlocks — one for line numbers, one for code — instead of one
//      element per line. A 400-line block therefore costs two elements, not eight hundred.
//      Alignment works because both use the same fixed LineHeight.
//   2. The block declares its own height cap and scrolls internally. A long code block must never
//      be allowed to resize the conversation, because that is what makes a transcript jump around
//      while it streams.
//   3. Horizontal overflow scrolls inside the block, so no code line can widen the page.
//
// 代码块自己管住高度和宽度：长代码不会让整页尺寸不断变化。

using System;
using System.Text;
using Cyrene.Navigator.Windows.Core.Text;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;

// The app's root namespace ends in `Windows`, which shadows the `Windows.*` WinRT namespaces
// inside namespace bodies. Aliasing here keeps call sites readable.
using WinFontStyle = Windows.UI.Text.FontStyle;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class CodeBlockView : Grid
{
    /// <summary>Rows rendered before the block truncates itself with a footer note.</summary>
    private const int MaxRenderedLines = 400;

    private readonly string _code;

    /// <param name="cached">
    /// Pre-tokenized source, when the caller keeps a cache on its model. Passing it lets a code
    /// block be re-created on container recycle without re-tokenizing.
    /// </param>
    public CodeBlockView(
        string code,
        string language,
        double maxHeight = 360,
        bool showHeader = true,
        bool showLineNumbers = true,
        Brush? fill = null,
        TokenizedCode? cached = null)
    {
        _code = code ?? string.Empty;

        var tokens = cached ?? CodeTokenizer.Tokenize(_code, language);
        var stack = new StackPanel { Orientation = Orientation.Vertical };

        if (showHeader)
        {
            stack.Children.Add(BuildHeader(language, tokens.LineCount));
        }

        stack.Children.Add(BuildBody(tokens, maxHeight, showLineNumbers));

        Children.Add(new Border
        {
            Background = fill ?? Tk.FillSandDeep,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Md,
            Child = stack,
        });
    }

    // -----------------------------------------------------------------------------------------

    private Grid BuildHeader(string language, int lineCount)
    {
        var header = new Grid
        {
            Padding = new Thickness(Tk.Sp.S12, Tk.Sp.S6, Tk.Sp.S6, Tk.Sp.S6),
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Bottom,
        };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        header.Children.Add(Ui.HStack(8,
            Ui.Diamond(Tk.Orchid, Tk.FillSandDeep, 6),
            Typo.Label(language is "text" or "" ? "PLAIN" : language, Tk.TextMuted)).At(0));

        header.Children.Add(Typo.Meta($"{lineCount} lines", Tk.TextMuted).At(1).WithAlignment());

        var copy = Ui.IconButton("\uE8C8", "Copy code", 26);
        copy.Click += (_, _) => CopyToClipboard();
        header.Children.Add(copy.At(2));

        return header;
    }

    private FrameworkElement BuildBody(TokenizedCode tokens, double maxHeight, bool showLineNumbers)
    {
        var rendered = Math.Min(tokens.LineCount, MaxRenderedLines);

        var codeText = new TextBlock
        {
            FontFamily = Tk.Ty.Mono,
            FontSize = Tk.Ty.Code,
            LineHeight = Tk.Ty.LineCode,
            LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
            TextWrapping = TextWrapping.NoWrap,
            IsTextSelectionEnabled = true,
            Foreground = Tk.TextInk,
        };

        for (var i = 0; i < rendered; i++)
        {
            if (i > 0)
            {
                codeText.Inlines.Add(new LineBreak());
            }

            foreach (var token in tokens.Lines[i])
            {
                codeText.Inlines.Add(RunFor(token));
            }
        }

        var codeScroll = new ScrollViewer
        {
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            VerticalScrollMode = ScrollMode.Disabled,
            Padding = new Thickness(showLineNumbers ? Tk.Sp.S12 : Tk.Sp.S16, 0, Tk.Sp.S16, 0),
            Content = codeText,
        };

        var body = new Grid();
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        if (showLineNumbers)
        {
            var numbers = new StringBuilder();
            for (var i = 1; i <= rendered; i++)
            {
                if (i > 1)
                {
                    numbers.Append('\n');
                }

                numbers.Append(i);
            }

            var gutter = new TextBlock
            {
                Text = numbers.ToString(),
                FontFamily = Tk.Ty.Mono,
                FontSize = Tk.Ty.Code,
                LineHeight = Tk.Ty.LineCode,
                LineStackingStrategy = LineStackingStrategy.BlockLineHeight,
                TextAlignment = TextAlignment.Right,
                Foreground = Tk.Wash(Tk.Raw.Muted, 0.55),
                IsTextSelectionEnabled = false,
                MinWidth = 22,
            };

            var gutterHost = new Border
            {
                Padding = new Thickness(Tk.Sp.S12, 0, Tk.Sp.S10, 0),
                BorderBrush = Tk.Line,
                BorderThickness = Tk.Ln.Right,
                Child = gutter,
            };
            body.Children.Add(gutterHost.At(0));
        }

        body.Children.Add(codeScroll.At(1));

        var padded = new Border
        {
            Padding = new Thickness(0, Tk.Sp.S10, 0, Tk.Sp.S10),
            Child = body,
        };

        FrameworkElement content = padded;

        if (tokens.LineCount > rendered)
        {
            var note = new Border
            {
                BorderBrush = Tk.Line,
                BorderThickness = Tk.Ln.Top,
                Padding = new Thickness(Tk.Sp.S12, Tk.Sp.S6, Tk.Sp.S12, Tk.Sp.S6),
                Child = Typo.Meta($"+{tokens.LineCount - rendered} more lines — open in editor to see the rest"),
            };
            content = Ui.VStack(0, padded, note);
        }

        // Only introduce a vertical scroller when the block would otherwise be tall enough to
        // dominate the reading column.
        var estimated = (rendered * Tk.Ty.LineCode) + (Tk.Sp.S10 * 2);
        if (estimated <= maxHeight)
        {
            return content;
        }

        return new ScrollViewer
        {
            MaxHeight = maxHeight,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollMode = ScrollMode.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollMode = ScrollMode.Disabled,
            Content = content,
        };
    }

    private static Run RunFor(CodeToken token)
    {
        var run = new Run { Text = token.Text };
        switch (token.Kind)
        {
            case CodeTokenKind.Keyword:
                run.Foreground = Tk.SynKeyword;
                run.FontWeight = FontWeights.SemiBold;
                break;
            case CodeTokenKind.Type:
                run.Foreground = Tk.SynType;
                break;
            case CodeTokenKind.Str:
                run.Foreground = Tk.SynString;
                break;
            case CodeTokenKind.Number:
                run.Foreground = Tk.SynNumber;
                break;
            case CodeTokenKind.Comment:
                run.Foreground = Tk.SynComment;
                run.FontStyle = WinFontStyle.Italic;
                break;
            case CodeTokenKind.Function:
                run.Foreground = Tk.SynFunction;
                run.FontWeight = FontWeights.SemiBold;
                break;
            case CodeTokenKind.Punct:
                run.Foreground = Tk.SynPunct;
                break;
            case CodeTokenKind.Meta:
                run.Foreground = Tk.SynMeta;
                break;
            case CodeTokenKind.DiffAdd:
                run.Foreground = Tk.Success;
                break;
            case CodeTokenKind.DiffDel:
                run.Foreground = Tk.Danger;
                break;
            case CodeTokenKind.DiffHunk:
                run.Foreground = Tk.Orchid;
                run.FontWeight = FontWeights.SemiBold;
                break;
            default:
                run.Foreground = Tk.TextInk;
                break;
        }

        return run;
    }

    private void CopyToClipboard()
    {
        try
        {
            var package = new DataPackage { RequestedOperation = DataPackageOperation.Copy };
            package.SetText(_code);
            Clipboard.SetContent(package);
        }
        catch (Exception)
        {
            // Clipboard access can fail transiently when another process holds it open.
            // Silently ignoring is correct here: there is nothing useful to tell the user.
        }
    }
}

internal static class AlignmentExtensions
{
    /// <summary>Right-aligns and vertically centres a metadata element inside a grid cell.</summary>
    internal static T WithAlignment<T>(this T element)
        where T : FrameworkElement
    {
        element.HorizontalAlignment = HorizontalAlignment.Right;
        element.VerticalAlignment = VerticalAlignment.Center;
        element.Margin = new Thickness(0, 0, Tk.Sp.S8, 0);
        return element;
    }
}
