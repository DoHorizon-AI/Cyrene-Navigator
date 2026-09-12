// Design/Tokens.cs
//
// Semantic design tokens for Cyrene Navigator / Navigator 语义化设计 token。
//
// This is the single source of truth for the product layer's look. Tokens are plain static
// members rather than XAML resource keys so that every usage is compile-checked, and so the
// same token set can be ported verbatim to the future macOS/Linux clients.
//
// Token families: Fill, Line, Text, Accent, Status, Gradient, Sp (spacing), Rad (radius),
// Ln (stroke widths), Ty (typography), Mo (motion).
//
// 只保留界面里真正用到的 token；没有"先设计 100 个 token 再找地方用"。

using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Windows.Foundation;
using Windows.UI;

namespace Cyrene.Navigator.Windows.Design;

/// <summary>
/// Active token set. Call <see cref="Use"/> once at startup (and again on theme change,
/// followed by rebuilding the shell) before touching any member.
/// </summary>
public static class Tk
{
    private static Palette _p = Palette.Light;

    public static CyreneTheme Theme { get; private set; } = CyreneTheme.Light;

    public static Palette Raw => _p;

    /// <summary>Switches the active palette and rebuilds every derived brush.</summary>
    public static void Use(CyreneTheme theme)
    {
        Theme = theme;
        _p = Palette.For(theme);
        Rebuild();
    }

    // ---- Fills ----------------------------------------------------------------------------
    /// <summary>Reading canvas behind conversations and page content.</summary>
    public static SolidColorBrush FillPaper { get; private set; } = null!;

    /// <summary>Chrome: navigation rail, list panes, page headers.</summary>
    public static SolidColorBrush FillSand { get; private set; } = null!;

    /// <summary>Inset surface: user turns, hovered rows, code wells, collapsed tool bodies.</summary>
    public static SolidColorBrush FillSandDeep { get; private set; } = null!;

    /// <summary>Pointer-over wash for hairline list rows. Intentionally barely there.</summary>
    public static SolidColorBrush FillHover { get; private set; } = null!;

    /// <summary>Pressed wash.</summary>
    public static SolidColorBrush FillPressed { get; private set; } = null!;

    /// <summary>Selected row wash, paired with a gradient edge indicator.</summary>
    public static SolidColorBrush FillSelected { get; private set; } = null!;

    /// <summary>Solid ink fill used by primary actions (mirrors the brand's `.btn.solid`).</summary>
    public static SolidColorBrush FillInk { get; private set; } = null!;

    public static SolidColorBrush FillTransparent { get; } = new(Color.FromArgb(0, 0, 0, 0));

    // ---- Lines ----------------------------------------------------------------------------
    /// <summary>The hairline. Structure in this product is drawn with 1px lines, not shadows.</summary>
    public static SolidColorBrush Line { get; private set; } = null!;

    /// <summary>Hairline for structural separations that must survive on Sand.</summary>
    public static SolidColorBrush LineStrong { get; private set; } = null!;

    /// <summary>Hairline at reduced presence, for pending/inactive geometry.</summary>
    public static SolidColorBrush LineFaint { get; private set; } = null!;

    /// <summary>
    /// Dashed hairline for "not reached yet" geometry. Implemented as an absolutely-mapped
    /// repeating gradient so the dash pitch stays 7px regardless of the element's height —
    /// a stroke dash array cannot do that on a stretch-aligned element.
    /// </summary>
    public static LinearGradientBrush LineDashed { get; private set; } = null!;

    // ---- Text -----------------------------------------------------------------------------
    public static SolidColorBrush TextInk { get; private set; } = null!;
    public static SolidColorBrush TextSlate { get; private set; } = null!;
    public static SolidColorBrush TextMuted { get; private set; } = null!;
    public static SolidColorBrush TextOnInk { get; private set; } = null!;

    // ---- Brand accents (used as ink, never as large fills) --------------------------------
    public static SolidColorBrush Coral { get; private set; } = null!;
    public static SolidColorBrush Rose { get; private set; } = null!;
    public static SolidColorBrush Orchid { get; private set; } = null!;

    // ---- Status ---------------------------------------------------------------------------
    public static SolidColorBrush Success { get; private set; } = null!;
    public static SolidColorBrush Warn { get; private set; } = null!;
    public static SolidColorBrush Danger { get; private set; } = null!;

    /// <summary>Very low-alpha status washes for diff gutters and status chips.</summary>
    public static SolidColorBrush SuccessWash { get; private set; } = null!;
    public static SolidColorBrush DangerWash { get; private set; } = null!;
    public static SolidColorBrush BrandWash { get; private set; } = null!;

    // ---- Gradients ------------------------------------------------------------------------
    // The gradient line is the product's core visual motif, so there are only a handful of
    // authorised gradients and each one has a specific job.

    /// <summary>
    /// Horizontal brand gradient, coral to orchid. Job: horizon rules, active navigation
    /// indicators, gradient card edges, emphasised numerals.
    /// </summary>
    public static LinearGradientBrush Horizon { get; private set; } = null!;

    /// <summary>
    /// Vertical trace at full strength, coral at the top flowing to orchid at the bottom.
    /// Job: the spine of an actively running agent.
    /// </summary>
    public static LinearGradientBrush TraceLive { get; private set; } = null!;

    /// <summary>
    /// Vertical trace that starts as a hairline and brightens into brand colour at the bottom.
    /// Job: the transition from settled history into "now". This is the single most important
    /// gradient in the product — the line literally gets brighter as it approaches the present.
    /// </summary>
    public static LinearGradientBrush TraceRise { get; private set; } = null!;

    /// <summary>Vertical trace fading from brand colour back down to hairline (below "now").</summary>
    public static LinearGradientBrush TraceFall { get; private set; } = null!;

    /// <summary>Diagonal brand gradient for 1.5px gradient borders on decision-bearing cards.</summary>
    public static LinearGradientBrush Edge { get; private set; } = null!;

    /// <summary>7% brand tint for featured surfaces. Never stronger than this.</summary>
    public static LinearGradientBrush BrandTint { get; private set; } = null!;

    /// <summary>Soft orchid halo behind the currently running step.</summary>
    public static RadialGradientBrush Halo { get; private set; } = null!;

    // ---- Syntax ---------------------------------------------------------------------------
    // The code theme is built from the brand hues rather than a borrowed editor palette, so a
    // code block reads as part of the same product as everything around it. Each hue is
    // darkened to stay legible on the warm well fill.
    public static SolidColorBrush SynKeyword { get; private set; } = null!;
    public static SolidColorBrush SynType { get; private set; } = null!;
    public static SolidColorBrush SynString { get; private set; } = null!;
    public static SolidColorBrush SynNumber { get; private set; } = null!;
    public static SolidColorBrush SynComment { get; private set; } = null!;
    public static SolidColorBrush SynFunction { get; private set; } = null!;
    public static SolidColorBrush SynPunct { get; private set; } = null!;
    public static SolidColorBrush SynMeta { get; private set; } = null!;

    /// <summary>Inline `code` inside prose. Same hue as numerals in code blocks.</summary>
    public static SolidColorBrush SynInline { get; private set; } = null!;

    // ---- Spacing (4px rhythm, only the steps actually used) --------------------------------
    public static class Sp
    {
        public const double S2 = 2;
        public const double S4 = 4;
        public const double S6 = 6;
        public const double S8 = 8;
        public const double S10 = 10;
        public const double S12 = 12;
        public const double S16 = 16;
        public const double S20 = 20;
        public const double S24 = 24;
        public const double S32 = 32;
        public const double S40 = 40;
        public const double S56 = 56;

        /// <summary>Width of the conversation trace gutter. Content aligns to its right edge.</summary>
        public const double Gutter = 40;

        /// <summary>Optimal measure for long-form assistant prose (~78ch at 14px).</summary>
        public const double Measure = 760;
    }

    // ---- Radius (the brand uses a very tight set: 2 / 3 / 4 / 6 / 8) ----------------------
    public static class Rad
    {
        /// <summary>Chips, tags, primary buttons. The brand's default.</summary>
        public static readonly CornerRadius Xs = new(2);

        public static readonly CornerRadius Sm = new(3);

        /// <summary>Cards, list rows, tool cards.</summary>
        public static readonly CornerRadius Md = new(4);

        /// <summary>Composer, dialogs, artifact cards.</summary>
        public static readonly CornerRadius Lg = new(6);

        public static readonly CornerRadius Xl = new(8);

        public static readonly CornerRadius Pill = new(999);

        public static readonly CornerRadius None = new(0);
    }

    // ---- Stroke widths --------------------------------------------------------------------
    public static class Ln
    {
        public static readonly Thickness Hair = new(1);
        public static readonly Thickness None = new(0);
        public static readonly Thickness Top = new(0, 1, 0, 0);
        public static readonly Thickness Bottom = new(0, 0, 0, 1);
        public static readonly Thickness Left = new(1, 0, 0, 0);
        public static readonly Thickness Right = new(0, 0, 1, 0);

        /// <summary>Stroke weight of trace lines and diamond nodes (from the brand stylesheet).</summary>
        public const double Node = 1.5;

        /// <summary>Trace spine weight.</summary>
        public const double Trace = 1.5;

        /// <summary>Active navigation / selection indicator weight.</summary>
        public const double Indicator = 2;
    }

    // ---- Typography -----------------------------------------------------------------------
    public static class Ty
    {
        /// <summary>
        /// Brand display face. Space Grotesk when present, otherwise the native Windows 11
        /// display face — so the app degrades to something that still belongs on Windows.
        /// </summary>
        public static readonly FontFamily Display =
            new("Space Grotesk, Segoe UI Variable Display, Segoe UI");

        /// <summary>Body face. Native by design: long-form reading should feel like Windows.</summary>
        public static readonly FontFamily Text =
            new("Segoe UI Variable Text, Segoe UI");

        public static readonly FontFamily Mono =
            new("Cascadia Code, Cascadia Mono, Consolas, Courier New");

        public static readonly FontFamily Icon = new("Segoe Fluent Icons, Segoe MDL2 Assets");

        public const double Eyebrow = 11;
        public const double Micro = 11;
        public const double Small = 12;
        public const double Meta = 12.5;
        public const double Body = 14;
        public const double BodyLead = 14.5;
        public const double Title = 16;
        public const double TitleLg = 19;
        public const double DisplaySm = 22;
        public const double DisplayMd = 27;
        public const double Code = 12.5;

        public const double LineBody = 22;
        public const double LineLead = 24;
        public const double LineCode = 19;
        public const double LineTitle = 22;

        /// <summary>Letter-spacing in 1/1000 em. Matches the brand's `.eyebrow` (0.22em).</summary>
        public const int TrackEyebrow = 200;

        /// <summary>Tighter tracking for small caps labels (0.08em).</summary>
        public const int TrackLabel = 80;

        /// <summary>Display headings tighten slightly (-0.01em).</summary>
        public const int TrackDisplay = -10;
    }

    // ---- Motion ---------------------------------------------------------------------------
    public static class Mo
    {
        /// <summary>Hover / pressed feedback.</summary>
        public static readonly Duration Fast = new(System.TimeSpan.FromMilliseconds(90));

        /// <summary>Standard state change: expand, select, indicator move.</summary>
        public static readonly Duration Base = new(System.TimeSpan.FromMilliseconds(160));

        /// <summary>Entrances and page-level reveals.</summary>
        public static readonly Duration Slow = new(System.TimeSpan.FromMilliseconds(260));

        /// <summary>Ambient loops (running-state breathing). Long enough to never nag.</summary>
        public static readonly System.TimeSpan Ambient = System.TimeSpan.FromMilliseconds(2200);

        /// <summary>Windows 11 "point to point" spline.</summary>
        public static KeySpline Standard => new() { ControlPoint1 = new Point(0.13, 0.62), ControlPoint2 = new Point(0.0, 0.99) };

        public static EasingFunctionBase EaseOut => new CubicEase { EasingMode = EasingMode.EaseOut };
    }

    // ---------------------------------------------------------------------------------------
    private static void Rebuild()
    {
        FillPaper = new SolidColorBrush(_p.Paper);
        FillSand = new SolidColorBrush(_p.Sand);
        FillSandDeep = new SolidColorBrush(_p.SandDeep);
        FillInk = new SolidColorBrush(_p.Ink);

        // Hover/pressed washes are derived from the palette rather than hard-coded so that the
        // dark theme automatically moves in the opposite direction.
        var lift = Theme == CyreneTheme.Light ? _p.SandDeep : _p.HairStrong;
        FillHover = new SolidColorBrush(Palette.Alpha(lift, Theme == CyreneTheme.Light ? 1.0 : 0.45));
        FillPressed = new SolidColorBrush(Palette.Alpha(_p.Hair, Theme == CyreneTheme.Light ? 0.9 : 0.75));
        FillSelected = new SolidColorBrush(Palette.Alpha(lift, Theme == CyreneTheme.Light ? 1.0 : 0.6));

        Line = new SolidColorBrush(_p.Hair);
        LineStrong = new SolidColorBrush(_p.HairStrong);
        LineFaint = new SolidColorBrush(Palette.Alpha(_p.Hair, 0.55));

        LineDashed = new LinearGradientBrush
        {
            MappingMode = BrushMappingMode.Absolute,
            StartPoint = new Point(0, 0),
            EndPoint = new Point(0, 7),
            SpreadMethod = GradientSpreadMethod.Repeat,
        };
        var dash = Palette.Alpha(_p.HairStrong, 0.75);
        var gap = Palette.Alpha(_p.Hair, 0.0);
        LineDashed.GradientStops.Add(new GradientStop { Offset = 0.0, Color = dash });
        LineDashed.GradientStops.Add(new GradientStop { Offset = 0.5, Color = dash });
        LineDashed.GradientStops.Add(new GradientStop { Offset = 0.5, Color = gap });
        LineDashed.GradientStops.Add(new GradientStop { Offset = 1.0, Color = gap });

        TextInk = new SolidColorBrush(_p.Ink);
        TextSlate = new SolidColorBrush(_p.Slate);
        TextMuted = new SolidColorBrush(_p.Muted);
        TextOnInk = new SolidColorBrush(_p.OnInk);

        Coral = new SolidColorBrush(_p.Coral);
        Rose = new SolidColorBrush(_p.Rose);
        Orchid = new SolidColorBrush(_p.Orchid);

        Success = new SolidColorBrush(_p.Success);
        Warn = new SolidColorBrush(_p.Warn);
        Danger = new SolidColorBrush(_p.Danger);
        SuccessWash = new SolidColorBrush(Palette.Alpha(_p.Success, 0.10));
        DangerWash = new SolidColorBrush(Palette.Alpha(_p.Danger, 0.10));
        BrandWash = new SolidColorBrush(Palette.Alpha(_p.Orchid, 0.09));

        if (Theme == CyreneTheme.Light)
        {
            SynKeyword = new SolidColorBrush(Palette.Rgb(0x8E, 0x4F, 0xA6));
            SynType = new SolidColorBrush(Palette.Rgb(0xA8, 0x54, 0x8A));
            SynString = new SolidColorBrush(Palette.Rgb(0x2E, 0x7D, 0x5B));
            SynNumber = new SolidColorBrush(Palette.Rgb(0xB8, 0x56, 0x4F));
            SynComment = new SolidColorBrush(Palette.Rgb(0x93, 0x90, 0x9D));
            SynFunction = new SolidColorBrush(Palette.Rgb(0x1B, 0x1E, 0x26));
            SynPunct = new SolidColorBrush(Palette.Rgb(0x6E, 0x6B, 0x78));
            SynMeta = new SolidColorBrush(Palette.Rgb(0xA8, 0x71, 0x2C));
            SynInline = new SolidColorBrush(Palette.Rgb(0xB0, 0x51, 0x4A));
        }
        else
        {
            SynKeyword = new SolidColorBrush(Palette.Rgb(0xD6, 0xA1, 0xE8));
            SynType = new SolidColorBrush(Palette.Rgb(0xE8, 0xA6, 0xC8));
            SynString = new SolidColorBrush(Palette.Rgb(0x7F, 0xD1, 0xAA));
            SynNumber = new SolidColorBrush(Palette.Rgb(0xF2, 0xA0, 0x9B));
            SynComment = new SolidColorBrush(Palette.Rgb(0x7A, 0x78, 0x86));
            SynFunction = new SolidColorBrush(Palette.Rgb(0xF2, 0xF0, 0xEC));
            SynPunct = new SolidColorBrush(Palette.Rgb(0x9C, 0x99, 0xA6));
            SynMeta = new SolidColorBrush(Palette.Rgb(0xE0, 0xB0, 0x6C));
            SynInline = new SolidColorBrush(Palette.Rgb(0xF2, 0xA0, 0x9B));
        }

        Horizon = Linear(new Point(0, 0), new Point(1, 0.12),
            (0.0, _p.Coral, 1.0), (0.5, _p.Rose, 1.0), (1.0, _p.Orchid, 1.0));

        TraceLive = Linear(new Point(0, 0), new Point(0, 1),
            (0.0, _p.Coral, 1.0), (0.5, _p.Rose, 1.0), (1.0, _p.Orchid, 1.0));

        TraceRise = Linear(new Point(0, 0), new Point(0, 1),
            (0.0, _p.Hair, 1.0), (0.42, _p.Orchid, 0.45), (0.78, _p.Rose, 0.9), (1.0, _p.Coral, 1.0));

        TraceFall = Linear(new Point(0, 0), new Point(0, 1),
            (0.0, _p.Coral, 1.0), (0.35, _p.Rose, 0.8), (1.0, _p.Hair, 1.0));

        Edge = Linear(new Point(0, 0), new Point(1, 1),
            (0.0, _p.Coral, 1.0), (0.5, _p.Rose, 1.0), (1.0, _p.Orchid, 1.0));

        BrandTint = Linear(new Point(0, 0), new Point(1, 1),
            (0.0, _p.Coral, 0.07), (1.0, _p.Orchid, 0.07));

        Halo = new RadialGradientBrush
        {
            Center = new Point(0.5, 0.5),
            GradientOrigin = new Point(0.5, 0.5),
            RadiusX = 0.5,
            RadiusY = 0.5,
        };
        Halo.GradientStops.Add(new GradientStop { Offset = 0.0, Color = Palette.Alpha(_p.Orchid, 0.16) });
        Halo.GradientStops.Add(new GradientStop { Offset = 0.55, Color = Palette.Alpha(_p.Coral, 0.09) });
        Halo.GradientStops.Add(new GradientStop { Offset = 1.0, Color = Palette.Alpha(_p.Coral, 0.0) });
    }

    private static LinearGradientBrush Linear(Point from, Point to, params (double Offset, Color Color, double Alpha)[] stops)
    {
        var brush = new LinearGradientBrush { StartPoint = from, EndPoint = to };
        foreach (var (offset, color, alpha) in stops)
        {
            brush.GradientStops.Add(new GradientStop
            {
                Offset = offset,
                Color = alpha >= 1.0 ? color : Palette.Alpha(color, alpha),
            });
        }

        return brush;
    }

    /// <summary>
    /// Fresh copy of the horizon gradient. Needed when an element animates the brush itself
    /// (shared brush instances would animate everywhere at once).
    /// </summary>
    public static LinearGradientBrush NewHorizon() => Linear(new Point(0, 0), new Point(1, 0.12),
        (0.0, _p.Coral, 1.0), (0.5, _p.Rose, 1.0), (1.0, _p.Orchid, 1.0));

    /// <summary>Fresh vertical live-trace gradient, for per-element animation.</summary>
    public static LinearGradientBrush NewTraceLive() => Linear(new Point(0, 0), new Point(0, 1),
        (0.0, _p.Coral, 1.0), (0.5, _p.Rose, 1.0), (1.0, _p.Orchid, 1.0));

    /// <summary>Solid brush at an arbitrary alpha of a palette colour.</summary>
    public static SolidColorBrush Wash(Color c, double alpha) => new(Palette.Alpha(c, alpha));

    static Tk() => Rebuild();
}
