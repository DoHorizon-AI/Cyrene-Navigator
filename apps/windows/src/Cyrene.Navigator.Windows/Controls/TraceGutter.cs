// Controls/TraceGutter.cs
//
// The trace / 轨迹线。
//
// This is the single most important control in the product. A 1.5px line runs down the left
// gutter of every timeline row; content hangs off it through short hairline elbows; diamond
// nodes mark the junctions that matter. The line is a hairline through settled history and
// becomes the brand gradient as it approaches the present.
//
// Continuity across a virtualized list is the hard part. Each row draws only its own slice, so
// if every live row painted the full coral→orchid ramp the result would be visible banding.
// Instead the timeline hands each row the gradient parameters (t0, t1) for its position, and the
// rows together render exactly one continuous gradient down the live region.
//
// 一句话：这条线不是装饰，它是"这次运行走过的路"。

using System;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Windows.UI;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class TraceGutter : Grid
{
    /// <summary>Horizontal position of the spine inside the gutter.</summary>
    private const double SpineX = 19.25;

    private const double NodeCentre = SpineX + (Tk.Ln.Trace / 2);

    /// <param name="role">How this row's slice of the spine is painted.</param>
    /// <param name="node">Which junction marker, if any, sits on this row.</param>
    /// <param name="t0">Gradient parameter at the top of this row (0 = coral, 1 = orchid).</param>
    /// <param name="t1">Gradient parameter at the bottom of this row.</param>
    /// <param name="nodeOffset">Distance from the row's top to the node centre.</param>
    /// <param name="elbow">Draw the short hairline that joins the spine to a hanging card.</param>
    /// <param name="startAtNode">Spine begins at the node instead of the row's top edge.</param>
    /// <param name="stopAtNode">Spine ends at the node instead of the row's bottom edge.</param>
    public TraceGutter(
        TraceRole role,
        NodeKind node = NodeKind.None,
        double t0 = 0,
        double t1 = 1,
        double nodeOffset = 15,
        bool elbow = false,
        bool startAtNode = false,
        bool stopAtNode = false,
        double width = Tk.Sp.Gutter)
    {
        Width = width;
        VerticalAlignment = VerticalAlignment.Stretch;
        IsHitTestVisible = false;

        if (role != TraceRole.None)
        {
            AddSpine(role, t0, t1, nodeOffset, startAtNode, stopAtNode);
        }

        if (elbow && role != TraceRole.None)
        {
            var connector = Ui.Elbow(width - NodeCentre - 3, SegmentBrushFlat(role, t1));
            connector.VerticalAlignment = VerticalAlignment.Top;
            connector.HorizontalAlignment = HorizontalAlignment.Left;
            connector.Margin = new Thickness(NodeCentre + 3, nodeOffset, 0, 0);
            Children.Add(connector);
        }

        if (node != NodeKind.None)
        {
            AddNode(node, nodeOffset);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Spine
    // -----------------------------------------------------------------------------------------

    private void AddSpine(TraceRole role, double t0, double t1, double nodeOffset, bool startAtNode, bool stopAtNode)
    {
        var spine = new Border
        {
            Width = Tk.Ln.Trace,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Stretch,
            Margin = new Thickness(SpineX, startAtNode ? nodeOffset : 0, 0, 0),
            Background = SegmentBrush(role, t0, t1),
        };

        if (stopAtNode)
        {
            // A stretch-aligned border cannot stop mid-row, so switch to a fixed height.
            spine.VerticalAlignment = VerticalAlignment.Top;
            spine.Height = nodeOffset;
        }

        Children.Add(spine);
    }

    /// <summary>
    /// Paint for this row's slice. Settled history is a flat hairline; the live region is a
    /// two-stop gradient sampled from the brand ramp at this row's position.
    /// </summary>
    private static Brush SegmentBrush(TraceRole role, double t0, double t1)
    {
        switch (role)
        {
            case TraceRole.Settled:
                return Tk.Line;

            case TraceRole.Pending:
                return Tk.LineDashed;

            case TraceRole.Rise:
            {
                // The handoff row: hairline at the top, brand colour by the bottom.
                var brush = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0, 1) };
                brush.GradientStops.Add(new GradientStop { Offset = 0, Color = Tk.Raw.Hair });
                brush.GradientStops.Add(new GradientStop { Offset = 0.55, Color = Palette.Alpha(Tk.Raw.Orchid, 0.45) });
                brush.GradientStops.Add(new GradientStop { Offset = 1, Color = BrandAt(0) });
                return brush;
            }

            case TraceRole.Live:
            {
                var brush = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0, 1) };
                brush.GradientStops.Add(new GradientStop { Offset = 0, Color = BrandAt(t0) });
                brush.GradientStops.Add(new GradientStop { Offset = 1, Color = BrandAt(t1) });
                return brush;
            }

            default:
                return Tk.FillTransparent;
        }
    }

    /// <summary>Flat colour matching a segment, for elbows and other short marks.</summary>
    private static Brush SegmentBrushFlat(TraceRole role, double t) => role switch
    {
        TraceRole.Live => new SolidColorBrush(Palette.Alpha(BrandAt(t), 0.85)),
        TraceRole.Rise => new SolidColorBrush(Palette.Alpha(BrandAt(0), 0.7)),
        TraceRole.Pending => Tk.LineFaint,
        _ => Tk.Line,
    };

    /// <summary>Samples the brand ramp: 0 = coral, 0.5 = rose, 1 = orchid.</summary>
    public static Color BrandAt(double t)
    {
        t = t <= 0 ? 0 : t >= 1 ? 1 : t;
        return t < 0.5
            ? Palette.Mix(Tk.Raw.Coral, Tk.Raw.Rose, t * 2)
            : Palette.Mix(Tk.Raw.Rose, Tk.Raw.Orchid, (t - 0.5) * 2);
    }

    // -----------------------------------------------------------------------------------------
    // Nodes
    // -----------------------------------------------------------------------------------------

    private void AddNode(NodeKind node, double nodeOffset)
    {
        if (node is NodeKind.Active or NodeKind.Blocked)
        {
            // Halo first so the diamond sits on top of it.
            var halo = new Ellipse
            {
                Width = 30,
                Height = 30,
                Fill = Tk.Halo,
                HorizontalAlignment = HorizontalAlignment.Left,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(NodeCentre - 15, nodeOffset - 15, 0, 0),
            };
            Children.Add(halo);

            if (node == NodeKind.Active)
            {
                Ui.Breathe(halo, 0.35, 1.0);
            }
        }

        FrameworkElement glyph = node switch
        {
            NodeKind.Active => Ui.SolidDiamond(8),
            NodeKind.Blocked => Ui.SolidDiamond(8),
            NodeKind.Marked => Ui.Diamond(Tk.Orchid),
            NodeKind.Failed => Ui.Diamond(Tk.Danger, Tk.DangerWash),
            NodeKind.Done => Ui.Diamond(Tk.LineStrong),
            _ => Ui.Diamond(Tk.LineStrong),
        };

        var size = glyph is Rectangle rect ? rect.Width : 7;
        glyph.HorizontalAlignment = HorizontalAlignment.Left;
        glyph.VerticalAlignment = VerticalAlignment.Top;
        glyph.Margin = new Thickness(NodeCentre - (size / 2), nodeOffset - (size / 2), 0, 0);
        Children.Add(glyph);
    }

    // -----------------------------------------------------------------------------------------
    // Gradient parameter allocation
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Computes the (t0, t1) pair for row <paramref name="index"/> of a live region containing
    /// <paramref name="count"/> rows, so the rows together form one uninterrupted ramp.
    /// </summary>
    public static (double T0, double T1) Segment(int index, int count)
    {
        if (count <= 1)
        {
            return (0, 1);
        }

        var step = 1.0 / count;
        var start = Math.Max(0, Math.Min(1, index * step));
        return (start, Math.Max(0, Math.Min(1, start + step)));
    }
}
