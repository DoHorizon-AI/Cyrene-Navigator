// Controls/Primitives.cs
//
// Product-layer visual primitives / 产品层视觉基元。
//
// Everything the Cyrene workspace is drawn from lives here: type ramp, hairline cards, chips,
// diamond nodes, horizon rules, gradient edges, sparklines. Built in code rather than XAML
// because the whole product layer is composed dynamically and because a typed factory catches
// mistakes that a XAML typo would only reveal at runtime.
//
// 命名约定：Typo.* 负责排版，Ui.* 负责结构与形状。两者都不依赖任何页面。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.UI;

namespace Cyrene.Navigator.Windows.Controls;

/// <summary>Type ramp. The only place font sizes and weights are decided.</summary>
public static class Typo
{
    /// <summary>
    /// Tracked uppercase micro-label. This is the product's signature label treatment, taken
    /// straight from the brand's `.eyebrow` (Space Grotesk, 0.22em tracking, uppercase).
    /// </summary>
    public static TextBlock Eyebrow(string text, Brush? brush = null) => new()
    {
        Text = text.ToUpperInvariant(),
        FontFamily = Tk.Ty.Display,
        FontSize = Tk.Ty.Eyebrow,
        FontWeight = FontWeights.SemiBold,
        CharacterSpacing = Tk.Ty.TrackEyebrow,
        Foreground = brush ?? Tk.TextMuted,
        TextLineBounds = TextLineBounds.Tight,
    };

    /// <summary>Tighter tracked label for inline status and metric captions.</summary>
    public static TextBlock Label(string text, Brush? brush = null) => new()
    {
        Text = text.ToUpperInvariant(),
        FontFamily = Tk.Ty.Display,
        FontSize = Tk.Ty.Micro,
        FontWeight = FontWeights.SemiBold,
        CharacterSpacing = Tk.Ty.TrackLabel,
        Foreground = brush ?? Tk.TextMuted,
    };

    /// <summary>Long-form body copy. Native face, generous leading — this is read for hours.</summary>
    public static TextBlock Body(string text, Brush? brush = null) => new()
    {
        Text = text,
        FontFamily = Tk.Ty.Text,
        FontSize = Tk.Ty.Body,
        LineHeight = Tk.Ty.LineBody,
        Foreground = brush ?? Tk.TextInk,
        TextWrapping = TextWrapping.Wrap,
    };

    /// <summary>Secondary metadata line.</summary>
    public static TextBlock Meta(string text, Brush? brush = null) => new()
    {
        Text = text,
        FontFamily = Tk.Ty.Text,
        FontSize = Tk.Ty.Meta,
        Foreground = brush ?? Tk.TextMuted,
        TextTrimming = TextTrimming.CharacterEllipsis,
        TextWrapping = TextWrapping.NoWrap,
    };

    /// <summary>Row and card titles.</summary>
    public static TextBlock Title(string text, double size = Tk.Ty.Title, Brush? brush = null) => new()
    {
        Text = text,
        FontFamily = Tk.Ty.Display,
        FontSize = size,
        FontWeight = FontWeights.SemiBold,
        CharacterSpacing = Tk.Ty.TrackDisplay,
        LineHeight = size * 1.32,
        Foreground = brush ?? Tk.TextInk,
        TextWrapping = TextWrapping.Wrap,
    };

    /// <summary>Page headings.</summary>
    public static TextBlock Display(string text, double size = Tk.Ty.DisplayMd) => new()
    {
        Text = text,
        FontFamily = Tk.Ty.Display,
        FontSize = size,
        FontWeight = FontWeights.SemiBold,
        CharacterSpacing = Tk.Ty.TrackDisplay,
        LineHeight = size * 1.18,
        Foreground = Tk.TextInk,
        TextWrapping = TextWrapping.Wrap,
    };

    /// <summary>
    /// Emphasised numeral painted with the brand gradient — the brand's `.stat-value`. Reserved
    /// for figures the user is meant to read at a glance, never for decoration.
    /// </summary>
    public static TextBlock Metric(string text, double size = Tk.Ty.DisplaySm) => new()
    {
        Text = text,
        FontFamily = Tk.Ty.Display,
        FontSize = size,
        FontWeight = FontWeights.SemiBold,
        LineHeight = size * 1.05,
        Foreground = Tk.Horizon,
    };

    /// <summary>Plain numeral, for figures that should not shout.</summary>
    public static TextBlock Figure(string text, double size = Tk.Ty.DisplaySm, Brush? brush = null) => new()
    {
        Text = text,
        FontFamily = Tk.Ty.Display,
        FontSize = size,
        FontWeight = FontWeights.SemiBold,
        LineHeight = size * 1.05,
        Foreground = brush ?? Tk.TextInk,
    };

    public static TextBlock Mono(string text, Brush? brush = null, double size = Tk.Ty.Code) => new()
    {
        Text = text,
        FontFamily = Tk.Ty.Mono,
        FontSize = size,
        LineHeight = Tk.Ty.LineCode,
        Foreground = brush ?? Tk.TextSlate,
        TextWrapping = TextWrapping.NoWrap,
        IsTextSelectionEnabled = false,
    };

    /// <summary>Segoe Fluent Icons glyph. System-layer iconography stays system iconography.</summary>
    public static TextBlock Glyph(string glyph, double size = 15, Brush? brush = null) => new()
    {
        Text = glyph,
        FontFamily = Tk.Ty.Icon,
        FontSize = size,
        Foreground = brush ?? Tk.TextSlate,
        VerticalAlignment = VerticalAlignment.Center,
        HorizontalAlignment = HorizontalAlignment.Center,
    };
}

/// <summary>Structural and shape primitives.</summary>
public static class Ui
{
    // -----------------------------------------------------------------------------------------
    // Layout helpers
    // -----------------------------------------------------------------------------------------

    public static StackPanel VStack(double spacing = 0, params UIElement[] children)
    {
        var panel = new StackPanel { Orientation = Orientation.Vertical, Spacing = spacing };
        foreach (var child in children)
        {
            panel.Children.Add(child);
        }

        return panel;
    }

    public static StackPanel HStack(double spacing = 0, params UIElement[] children)
    {
        var panel = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            Spacing = spacing,
            VerticalAlignment = VerticalAlignment.Center,
        };
        foreach (var child in children)
        {
            panel.Children.Add(child);
        }

        return panel;
    }

    /// <summary>Flexible spacer for horizontal rows.</summary>
    public static FrameworkElement Spring() => new Border { HorizontalAlignment = HorizontalAlignment.Stretch };

    public static Grid Columns(params GridLength[] widths)
    {
        var grid = new Grid();
        foreach (var width in widths)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = width });
        }

        return grid;
    }

    public static Grid Rows(params GridLength[] heights)
    {
        var grid = new Grid();
        foreach (var height in heights)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = height });
        }

        return grid;
    }

    public static T At<T>(this T element, int column = 0, int row = 0, int columnSpan = 1, int rowSpan = 1)
        where T : FrameworkElement
    {
        Grid.SetColumn(element, column);
        Grid.SetRow(element, row);
        if (columnSpan > 1)
        {
            Grid.SetColumnSpan(element, columnSpan);
        }

        if (rowSpan > 1)
        {
            Grid.SetRowSpan(element, rowSpan);
        }

        return element;
    }

    public static GridLength Star(double value = 1) => new(value, GridUnitType.Star);

    public static GridLength Px(double value) => new(value, GridUnitType.Pixel);

    public static GridLength Auto => GridLength.Auto;

    // -----------------------------------------------------------------------------------------
    // Surfaces
    // -----------------------------------------------------------------------------------------

    /// <summary>Standard hairline card. Structure is a 1px line, not a shadow.</summary>
    public static Border Card(UIElement? content = null, Thickness? padding = null, Brush? fill = null)
    {
        var border = new Border
        {
            Background = fill ?? Tk.FillPaper,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Md,
            Padding = padding ?? new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12),
        };
        if (content is not null)
        {
            border.Child = content;
        }

        return border;
    }

    /// <summary>
    /// Card with a 1.5px brand-gradient border, produced the same way the website does it:
    /// a gradient-filled outer border with a paper-filled inner border inset by the stroke.
    /// Reserved for cards that carry a decision or a headline figure.
    /// </summary>
    public static Border GradientCard(UIElement content, Thickness? padding = null, Brush? fill = null)
    {
        var inner = new Border
        {
            Background = fill ?? Tk.FillPaper,
            CornerRadius = new CornerRadius(4.5),
            Padding = padding ?? new Thickness(Tk.Sp.S20, Tk.Sp.S16, Tk.Sp.S20, Tk.Sp.S16),
            Child = content,
        };

        return new Border
        {
            Background = Tk.Edge,
            CornerRadius = new CornerRadius(6),
            Padding = new Thickness(1.5),
            Child = inner,
        };
    }

    /// <summary>Recessed well for code and tool output.</summary>
    public static Border Well(UIElement content, Thickness? padding = null) => new()
    {
        Background = Tk.FillSandDeep,
        BorderBrush = Tk.Line,
        BorderThickness = Tk.Ln.Hair,
        CornerRadius = Tk.Rad.Md,
        Padding = padding ?? new Thickness(0),
        Child = content,
    };

    /// <summary>1px horizontal hairline.</summary>
    public static Border Divider(double top = 0, double bottom = 0) => new()
    {
        Height = 1,
        Background = Tk.Line,
        Margin = new Thickness(0, top, 0, bottom),
        HorizontalAlignment = HorizontalAlignment.Stretch,
    };

    /// <summary>1px vertical hairline.</summary>
    public static Border VDivider() => new()
    {
        Width = 1,
        Background = Tk.Line,
        VerticalAlignment = VerticalAlignment.Stretch,
    };

    /// <summary>
    /// The brand's horizon rule: a full-width hairline with the brand gradient covering the
    /// leading 38%, punctuated by two diamond nodes. Used to close page headers and to separate
    /// major sections — it is the flat, one-dimensional form of the trace.
    /// </summary>
    public static Grid HorizonRule(double gradientFraction = 0.38, bool animate = true)
    {
        var grid = new Grid { Height = 8, HorizontalAlignment = HorizontalAlignment.Stretch };

        var hair = new Border
        {
            Height = 1,
            Background = Tk.Line,
            VerticalAlignment = VerticalAlignment.Top,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Margin = new Thickness(0, 3.5, 0, 0),
        };
        grid.Children.Add(hair);

        var lit = new Border
        {
            Height = 1,
            Background = Tk.Horizon,
            VerticalAlignment = VerticalAlignment.Top,
            HorizontalAlignment = HorizontalAlignment.Left,
            Margin = new Thickness(0, 3.5, 0, 0),
            RenderTransformOrigin = new Point(0, 0.5),
        };
        grid.Children.Add(lit);

        // The lit segment is a fraction of the rule, so it has to be measured, not guessed.
        grid.SizeChanged += (_, e) => lit.Width = Math.Max(0, e.NewSize.Width * gradientFraction);

        var nodeA = Diamond(Tk.Coral);
        nodeA.HorizontalAlignment = HorizontalAlignment.Left;
        nodeA.VerticalAlignment = VerticalAlignment.Top;
        grid.Children.Add(nodeA);

        var nodeB = Diamond(Tk.Orchid);
        nodeB.HorizontalAlignment = HorizontalAlignment.Left;
        nodeB.VerticalAlignment = VerticalAlignment.Top;
        grid.Children.Add(nodeB);

        grid.SizeChanged += (_, e) =>
        {
            nodeA.Margin = new Thickness(Math.Max(0, (e.NewSize.Width * gradientFraction * 0.47) - 4), 0, 0, 0);
            nodeB.Margin = new Thickness(Math.Max(0, (e.NewSize.Width * gradientFraction) - 4), 0, 0, 0);
        };

        if (animate)
        {
            // Reveal the lit segment on entrance. One page-level gesture, not a loop.
            var transform = new ScaleTransform { ScaleX = 0, ScaleY = 1 };
            lit.RenderTransform = transform;
            var story = new Storyboard();
            var animation = new DoubleAnimation
            {
                From = 0,
                To = 1,
                Duration = new Duration(TimeSpan.FromMilliseconds(520)),
                EasingFunction = Tk.Mo.EaseOut,
            };
            Storyboard.SetTarget(animation, lit);
            Storyboard.SetTargetProperty(animation, "(UIElement.RenderTransform).(ScaleTransform.ScaleX)");
            story.Children.Add(animation);
            PlayWhenLive(lit, story, () => transform.ScaleX = 1);
        }

        return grid;
    }

    // -----------------------------------------------------------------------------------------
    // The diamond node
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// The brand's node glyph: a 7×7 square rotated 45°, hairline stroke, paper fill. It marks
    /// every junction on a trace — a turn, a decision, an artifact.
    /// </summary>
    public static Rectangle Diamond(Brush stroke, Brush? fill = null, double size = 7)
    {
        return new Rectangle
        {
            Width = size,
            Height = size,
            Stroke = stroke,
            StrokeThickness = Tk.Ln.Node,
            Fill = fill ?? Tk.FillPaper,
            RenderTransform = new RotateTransform { Angle = 45 },
            RenderTransformOrigin = new Point(0.5, 0.5),
        };
    }

    /// <summary>Filled gradient diamond, used only for "this is happening now".</summary>
    public static Rectangle SolidDiamond(double size = 8) => new()
    {
        Width = size,
        Height = size,
        Fill = Tk.Edge,
        RenderTransform = new RotateTransform { Angle = 45 },
        RenderTransformOrigin = new Point(0.5, 0.5),
    };

    /// <summary>Small status dot for list rows where a diamond would be too loud.</summary>
    public static Ellipse Dot(Brush fill, double size = 6) => new()
    {
        Width = size,
        Height = size,
        Fill = fill,
    };

    /// <summary>
    /// Short horizontal hairline joining the trace spine to a card. This is the branching
    /// gesture in the brand language — content hangs off the line rather than floating next
    /// to it.
    /// </summary>
    public static Border Elbow(double width = 12, Brush? brush = null) => new()
    {
        Width = width,
        Height = 1,
        Background = brush ?? Tk.Line,
        VerticalAlignment = VerticalAlignment.Center,
        HorizontalAlignment = HorizontalAlignment.Left,
    };

    // -----------------------------------------------------------------------------------------
    // Chips, tags, buttons
    // -----------------------------------------------------------------------------------------

    /// <summary>Neutral tag, matching the brand's `.model-tags li`.</summary>
    public static Border Chip(string text, Brush? fill = null, Brush? textBrush = null, Brush? border = null)
    {
        return new Border
        {
            Background = fill ?? Tk.FillSand,
            BorderBrush = border ?? Tk.FillTransparent,
            BorderThickness = border is null ? Tk.Ln.None : Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Xs,
            Padding = new Thickness(8, 3, 8, 4),
            VerticalAlignment = VerticalAlignment.Center,
            Child = new TextBlock
            {
                Text = text,
                FontFamily = Tk.Ty.Text,
                FontSize = Tk.Ty.Small,
                Foreground = textBrush ?? Tk.TextSlate,
            },
        };
    }

    /// <summary>Tracked micro chip used for tool families and tiers.</summary>
    public static Border KindChip(string text, Brush accent)
    {
        return new Border
        {
            Background = Tk.FillTransparent,
            BorderBrush = Tk.FillTransparent,
            CornerRadius = Tk.Rad.Xs,
            Padding = new Thickness(0),
            VerticalAlignment = VerticalAlignment.Center,
            Child = HStack(6,
                Diamond(accent, Tk.FillPaper, 6),
                Typo.Label(text, accent)),
        };
    }

    /// <summary>
    /// Primary action. Ink fill, 2px radius, display face — the brand's `.btn.solid`. Deliberately
    /// not an accent-coloured button: the brand does not build identity out of saturated fills.
    /// </summary>
    public static Button Solid(string text, string? glyph = null)
    {
        var content = glyph is null
            ? (UIElement)new TextBlock
            {
                Text = text,
                FontFamily = Tk.Ty.Display,
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                CharacterSpacing = 20,
            }
            : HStack(8,
                Typo.Glyph(glyph, 14, Tk.TextOnInk),
                new TextBlock
                {
                    Text = text,
                    FontFamily = Tk.Ty.Display,
                    FontSize = 13,
                    FontWeight = FontWeights.SemiBold,
                    CharacterSpacing = 20,
                });

        return new Button
        {
            Content = content,
            Background = Tk.FillInk,
            Foreground = Tk.TextOnInk,
            BorderThickness = Tk.Ln.None,
            CornerRadius = Tk.Rad.Xs,
            Padding = new Thickness(16, 8, 16, 9),
        };
    }

    /// <summary>Secondary action: hairline outline on paper.</summary>
    public static Button Outline(string text, string? glyph = null)
    {
        var content = glyph is null
            ? (UIElement)new TextBlock
            {
                Text = text,
                FontFamily = Tk.Ty.Display,
                FontSize = 13,
                FontWeight = FontWeights.SemiBold,
                CharacterSpacing = 20,
            }
            : HStack(8,
                Typo.Glyph(glyph, 14, Tk.TextInk),
                new TextBlock
                {
                    Text = text,
                    FontFamily = Tk.Ty.Display,
                    FontSize = 13,
                    FontWeight = FontWeights.SemiBold,
                    CharacterSpacing = 20,
                });

        return new Button
        {
            Content = content,
            Background = Tk.FillPaper,
            Foreground = Tk.TextInk,
            BorderBrush = Tk.LineStrong,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Xs,
            Padding = new Thickness(16, 8, 16, 9),
        };
    }

    /// <summary>Tertiary action: text only, no chrome until hover.</summary>
    public static Button Ghost(string text, string? glyph = null)
    {
        var content = glyph is null
            ? (UIElement)new TextBlock
            {
                Text = text,
                FontFamily = Tk.Ty.Display,
                FontSize = 12.5,
                FontWeight = FontWeights.SemiBold,
                CharacterSpacing = 20,
            }
            : HStack(6,
                Typo.Glyph(glyph, 13, Tk.TextSlate),
                new TextBlock
                {
                    Text = text,
                    FontFamily = Tk.Ty.Display,
                    FontSize = 12.5,
                    FontWeight = FontWeights.SemiBold,
                    CharacterSpacing = 20,
                });

        return new Button
        {
            Content = content,
            Background = Tk.FillTransparent,
            Foreground = Tk.TextSlate,
            BorderThickness = Tk.Ln.None,
            CornerRadius = Tk.Rad.Xs,
            Padding = new Thickness(8, 5, 8, 6),
        };
    }

    /// <summary>Square icon-only button, sized on the Windows 32px touch-friendly grid.</summary>
    public static Button IconButton(string glyph, string tooltip, double size = 32)
    {
        var button = new Button
        {
            Content = Typo.Glyph(glyph, 15, Tk.TextSlate),
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            CornerRadius = Tk.Rad.Md,
            Width = size,
            Height = size,
            Padding = new Thickness(0),
        };
        ToolTipService.SetToolTip(button, tooltip);
        return button;
    }

    // -----------------------------------------------------------------------------------------
    // Data marks
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Hairline bar sparkline. Bars rather than a polyline because at this size a line reads as
    /// noise while bars stay countable.
    /// </summary>
    public static Grid Sparkline(IReadOnlyList<double> series, double height = 26, Brush? brush = null)
    {
        var grid = new Grid { Height = height, ColumnSpacing = 3, VerticalAlignment = VerticalAlignment.Bottom };
        for (var i = 0; i < series.Count; i++)
        {
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = Star() });
            var value = Math.Max(0.06, Math.Min(1, series[i]));
            // Last 3 bars get progressive brand opacity so recency reads at a glance.
            var tail = series.Count - 1 - i; // 0 = last bar, 1 = second-to-last, etc.
            Brush barBrush;
            double barOpacity;
            if (tail <= 2)
            {
                barBrush = brush ?? Tk.Horizon;
                barOpacity = tail == 0 ? 1.0 : tail == 1 ? 0.65 : 0.35;
            }
            else
            {
                barBrush = Tk.LineStrong;
                barOpacity = 1.0;
            }

            var bar = new Border
            {
                Background = barBrush,
                Opacity = barOpacity,
                Height = height * value,
                VerticalAlignment = VerticalAlignment.Bottom,
                CornerRadius = new CornerRadius(1),
            };
            Grid.SetColumn(bar, i);
            grid.Children.Add(bar);
        }

        return grid;
    }

    /// <summary>Thin horizontal meter. The filled portion uses the brand gradient.</summary>
    public static Grid Meter(double fraction, double width = 120, double height = 3, Brush? fill = null)
    {
        var track = new Border
        {
            Height = height,
            Background = Tk.Line,
            CornerRadius = new CornerRadius(height / 2),
            HorizontalAlignment = HorizontalAlignment.Stretch,
        };
        var value = new Border
        {
            Height = height,
            Background = fill ?? Tk.Horizon,
            CornerRadius = new CornerRadius(height / 2),
            HorizontalAlignment = HorizontalAlignment.Left,
        };

        var grid = new Grid { Width = double.IsNaN(width) ? double.NaN : width, Height = height };
        grid.Children.Add(track);
        grid.Children.Add(value);
        grid.SizeChanged += (_, e) =>
            value.Width = Math.Max(0, e.NewSize.Width * Math.Max(0, Math.Min(1, fraction)));
        return grid;
    }

    // -----------------------------------------------------------------------------------------
    // Interaction affordances
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Adds Windows-11-shaped hover and pressed feedback to a bare border, without retemplating
    /// anything. Keeps custom surfaces behaving the way the rest of the OS behaves.
    /// </summary>
    public static Border Interactive(this Border border, Brush? hover = null, Brush? baseFill = null)
    {
        var rest = baseFill ?? border.Background;
        border.PointerEntered += (_, _) => border.Background = hover ?? Tk.FillHover;
        border.PointerExited += (_, _) => border.Background = rest;
        border.PointerCaptureLost += (_, _) => border.Background = rest;
        border.PointerPressed += (_, _) => border.Background = Tk.FillPressed;
        border.PointerReleased += (_, _) => border.Background = hover ?? Tk.FillHover;
        return border;
    }

    /// <summary>Border whose hairline warms to orchid on hover — the brand's card hover.</summary>
    public static Border EdgeHover(this Border border)
    {
        border.PointerEntered += (_, _) => border.BorderBrush = Tk.Wash(Tk.Raw.Orchid, 0.7);
        border.PointerExited += (_, _) => border.BorderBrush = Tk.Line;
        return border;
    }

    /// <summary>Opacity fade-in used for content revealed by expansion.</summary>
    public static void FadeIn(UIElement element, double milliseconds = 160)
    {
        element.Opacity = 0;
        var story = new Storyboard();
        var animation = new DoubleAnimation
        {
            From = 0,
            To = 1,
            Duration = new Duration(TimeSpan.FromMilliseconds(milliseconds)),
            EasingFunction = Tk.Mo.EaseOut,
        };
        Storyboard.SetTarget(animation, element);
        Storyboard.SetTargetProperty(animation, "Opacity");
        story.Children.Add(animation);
        PlayWhenLive(element, story, () => element.Opacity = 1);
    }

    /// <summary>
    /// Slow breathing loop applied to the "running now" marks. 2.2s and a shallow opacity range
    /// so that a long run never becomes irritating to sit next to.
    /// </summary>
    public static void Breathe(UIElement element, double from = 0.45, double to = 1.0)
    {
        var story = new Storyboard { RepeatBehavior = RepeatBehavior.Forever, AutoReverse = true };
        var animation = new DoubleAnimation
        {
            From = from,
            To = to,
            Duration = new Duration(Tk.Mo.Ambient),
            EasingFunction = new SineEase { EasingMode = EasingMode.EaseInOut },
        };
        Storyboard.SetTarget(animation, element);
        Storyboard.SetTargetProperty(animation, "Opacity");
        story.Children.Add(animation);

        // A forever-repeating storyboard holds its target alive, so it has to be released when
        // the row is recycled out of the virtualized list.
        if (element is FrameworkElement framework)
        {
            framework.Unloaded += (_, _) => story.Stop();
        }

        PlayWhenLive(element, story, null);
    }

    /// <summary>
    /// Starts <paramref name="story"/> once <paramref name="element"/> is actually in the visual
    /// tree. Every control in this product is composed in code and animated in its constructor,
    /// which means the target is normally still detached at that point — and starting a
    /// storyboard against a detached element throws.
    ///
    /// <paramref name="settle"/> is applied if the element never loads, so a one-shot entrance
    /// animation cannot leave content stuck at zero opacity.
    /// </summary>
    public static void PlayWhenLive(UIElement element, Storyboard story, Action? settle = null)
    {
        if (element is not FrameworkElement framework)
        {
            return;
        }

        if (framework.IsLoaded)
        {
            story.Begin();
            return;
        }

        settle?.Invoke();

        void OnLoaded(object sender, RoutedEventArgs e)
        {
            framework.Loaded -= OnLoaded;
            story.Begin();
        }

        framework.Loaded += OnLoaded;
    }

    /// <summary>Formats a duration the way an engineer reads it.</summary>
    public static string Duration(TimeSpan span)
    {
        if (span.TotalMilliseconds < 1)
        {
            return "0ms";
        }

        if (span.TotalMilliseconds < 1_000)
        {
            return $"{span.TotalMilliseconds:0}ms";
        }

        if (span.TotalSeconds < 60)
        {
            return $"{span.TotalSeconds:0.0}s";
        }

        return span.TotalHours < 1
            ? $"{(int)span.TotalMinutes}m {span.Seconds:00}s"
            : $"{(int)span.TotalHours}h {span.Minutes:00}m";
    }

    /// <summary>Compact token counts: 184 320 becomes 184.3K.</summary>
    public static string Tokens(int count) => count switch
    {
        >= 1_000_000 => $"{count / 1_000_000.0:0.0}M",
        >= 1_000 => $"{count / 1_000.0:0.0}K",
        _ => count.ToString(System.Globalization.CultureInfo.InvariantCulture),
    };

    public static string Clock(DateTimeOffset at) => at.ToString("HH:mm", System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>Relative time for session rows.</summary>
    public static string Ago(DateTimeOffset at, DateTimeOffset now)
    {
        var span = now - at;
        if (span < TimeSpan.FromMinutes(1))
        {
            return "now";
        }

        if (span < TimeSpan.FromHours(1))
        {
            return $"{(int)span.TotalMinutes}m";
        }

        if (span < TimeSpan.FromDays(1))
        {
            return $"{(int)span.TotalHours}h";
        }

        return $"{(int)span.TotalDays}d";
    }

    /// <summary>Colour a solid brush from a raw palette colour at partial opacity.</summary>
    public static SolidColorBrush Tint(Color color, double alpha) => new(Palette.Alpha(color, alpha));
}
