// Controls/DiffView.cs
//
// Unified diff / 差异视图。
//
// Unlike a code block, a diff needs per-line backgrounds, so it does pay for one row per line.
// That is affordable because diffs in a transcript are hunks, not files — and the view enforces
// that by capping itself and saying how much it hid.
//
// Colour is kept at 10% wash with a saturated sign in the gutter: at full saturation a diff
// turns into a traffic light and stops being readable prose.
//
// 差异行用 10% 的底色 + 饱和的 +/- 符号；不使用大面积绿红填充。

using System;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class DiffView : Grid
{
    private const int MaxRenderedLines = 90;

    public DiffView(DiffItem item)
    {
        var stack = new StackPanel { Orientation = Orientation.Vertical };
        stack.Children.Add(BuildHeader(item));
        stack.Children.Add(BuildHunks(item));

        Children.Add(new Border
        {
            Background = Tk.FillPaper,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Md,
            Child = stack,
        });
    }

    private static FrameworkElement BuildHeader(DiffItem item)
    {
        var row = new Grid
        {
            Padding = new Thickness(Tk.Sp.S12, Tk.Sp.S10, Tk.Sp.S12, Tk.Sp.S10),
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Bottom,
            ColumnSpacing = Tk.Sp.S10,
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        row.Children.Add(Ui.KindChip("DIFF", Tk.Rose).At(0));

        var path = Typo.Mono(item.Path, Tk.Wash(Tk.Raw.Ink, 0.9));
        path.TextTrimming = TextTrimming.CharacterEllipsis;
        path.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(path.At(1));

        var counts = Ui.HStack(Tk.Sp.S8,
            Typo.Mono("+" + item.Added, Tk.Success, 11.5),
            Typo.Mono("−" + item.Removed, Tk.Danger, 11.5));
        counts.HorizontalAlignment = HorizontalAlignment.Right;
        row.Children.Add(counts.At(2));

        return row;
    }

    private static FrameworkElement BuildHunks(DiffItem item)
    {
        var lines = (item.Patch ?? string.Empty).Replace("\r\n", "\n").Split('\n');
        var rendered = Math.Min(lines.Length, MaxRenderedLines);

        var stack = new StackPanel
        {
            Orientation = Orientation.Vertical,
            Margin = new Thickness(0, Tk.Sp.S6, 0, Tk.Sp.S6),
        };

        for (var i = 0; i < rendered; i++)
        {
            var line = lines[i];

            // File headers are noise once the path is already in the card header.
            if (line.StartsWith("--- ", StringComparison.Ordinal) || line.StartsWith("+++ ", StringComparison.Ordinal))
            {
                continue;
            }

            stack.Children.Add(BuildLine(line));
        }

        if (lines.Length > rendered)
        {
            stack.Children.Add(new Border
            {
                Padding = new Thickness(Tk.Sp.S12, Tk.Sp.S6, Tk.Sp.S12, 0),
                Child = Typo.Meta($"+{lines.Length - rendered} more lines in this patch"),
            });
        }

        return new ScrollViewer
        {
            MaxHeight = 340,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Auto,
            Content = stack,
        };
    }

    private static FrameworkElement BuildLine(string line)
    {
        Brush wash = Tk.FillTransparent;
        Brush signBrush = Tk.Wash(Tk.Raw.Muted, 0.45);
        Brush textBrush = Tk.Wash(Tk.Raw.Ink, 0.82);
        var sign = " ";
        var body = line;

        if (line.StartsWith("@@", StringComparison.Ordinal))
        {
            return new Border
            {
                Background = Tk.BrandWash,
                Padding = new Thickness(Tk.Sp.S12, 2, Tk.Sp.S12, 3),
                Margin = new Thickness(0, Tk.Sp.S4, 0, Tk.Sp.S4),
                Child = Typo.Mono(line, Tk.Orchid, 11.5),
            };
        }

        if (line.StartsWith("+", StringComparison.Ordinal))
        {
            wash = Tk.SuccessWash;
            signBrush = Tk.Success;
            sign = "+";
            body = line[1..];
        }
        else if (line.StartsWith("-", StringComparison.Ordinal))
        {
            wash = Tk.DangerWash;
            signBrush = Tk.Danger;
            sign = "−";
            body = line[1..];
        }
        else if (line.Length > 0 && line[0] == ' ')
        {
            body = line[1..];
        }

        var row = new Grid { Background = wash };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(26) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        var signText = Typo.Mono(sign, signBrush, 11.5);
        signText.TextAlignment = TextAlignment.Center;
        signText.FontWeight = FontWeights.SemiBold;
        row.Children.Add(signText.At(0));

        var bodyText = Typo.Mono(body, textBrush);
        bodyText.Margin = new Thickness(0, 0, Tk.Sp.S12, 0);
        row.Children.Add(bodyText.At(1));

        return row;
    }
}
