// Design/Palette.cs
//
// Raw brand colour values for Cyrene Navigator / Cyrene Navigator 品牌原色。
//
// Every value below is lifted from the public Do Horizon brand stylesheet so the
// desktop client and the web presence share one palette rather than two approximations of it.
// Nothing in this file describes *usage*; semantic mapping lives in Tokens.cs.
//
// 本文件只放原色，不描述用途；语义映射在 Tokens.cs。

using Windows.UI;

namespace Cyrene.Navigator.Windows.Design;

/// <summary>Which of the two palettes is active.</summary>
public enum CyreneTheme
{
    Light,
    Dark,
}

/// <summary>
/// A complete set of raw colours for one theme. Instances are immutable and there are exactly
/// two of them (<see cref="Palette.Light"/> and <see cref="Palette.Dark"/>).
/// </summary>
public sealed class Palette
{
    // ---- Surfaces -------------------------------------------------------------------------
    /// <summary>Reading canvas. Warm off-white; deliberately not #FFFFFF.</summary>
    public Color Paper { get; init; }

    /// <summary>Chrome surface for rails, sidebars and headers.</summary>
    public Color Sand { get; init; }

    /// <summary>Recessed/inset surface: user turns, hovered rows, code wells.</summary>
    public Color SandDeep { get; init; }

    /// <summary>Hairline border. The single most-used non-text colour in the product.</summary>
    public Color Hair { get; init; }

    /// <summary>Hairline with more presence, for structural dividers only.</summary>
    public Color HairStrong { get; init; }

    // ---- Text -----------------------------------------------------------------------------
    /// <summary>Primary text.</summary>
    public Color Ink { get; init; }

    /// <summary>Secondary text and body copy in dense areas.</summary>
    public Color Slate { get; init; }

    /// <summary>Tertiary text: eyebrows, metadata, settled history.</summary>
    public Color Muted { get; init; }

    // ---- Brand gradient stops -------------------------------------------------------------
    /// <summary>Warm end of the brand gradient. Reads as "active / happening now".</summary>
    public Color Coral { get; init; }

    /// <summary>Midpoint of the brand gradient.</summary>
    public Color Rose { get; init; }

    /// <summary>Cool end of the brand gradient. Reads as "settled / significant".</summary>
    public Color Orchid { get; init; }

    // ---- Status ---------------------------------------------------------------------------
    public Color Success { get; init; }

    /// <summary>Attention without alarm. Warm ochre, never a saturated web-warning yellow.</summary>
    public Color Warn { get; init; }

    /// <summary>Failure. A darkened coral so failures stay inside the brand, not outside it.</summary>
    public Color Danger { get; init; }

    /// <summary>Text/icon colour placed on top of an <see cref="Ink"/> fill.</summary>
    public Color OnInk { get; init; }

    public static Color Rgb(byte r, byte g, byte b) => Color.FromArgb(0xFF, r, g, b);

    public static Color Argb(byte a, byte r, byte g, byte b) => Color.FromArgb(a, r, g, b);

    /// <summary>Returns <paramref name="c"/> at <paramref name="alpha"/> (0..1) opacity.</summary>
    public static Color Alpha(Color c, double alpha)
    {
        var a = alpha <= 0 ? 0 : alpha >= 1 ? 255 : (int)System.Math.Round(alpha * 255.0);
        return Color.FromArgb((byte)a, c.R, c.G, c.B);
    }

    /// <summary>Linear blend, <paramref name="t"/> = 0 returns <paramref name="a"/>.</summary>
    public static Color Mix(Color a, Color b, double t)
    {
        t = t <= 0 ? 0 : t >= 1 ? 1 : t;
        byte L(byte x, byte y) => (byte)System.Math.Round(x + (y - x) * t);
        return Color.FromArgb(L(a.A, b.A), L(a.R, b.R), L(a.G, b.G), L(a.B, b.B));
    }

    public static readonly Palette Light = new()
    {
        Paper = Rgb(0xFB, 0xFA, 0xF8),
        Sand = Rgb(0xF3, 0xF0, 0xEC),
        SandDeep = Rgb(0xF5, 0xF2, 0xEE),
        Hair = Rgb(0xE9, 0xE5, 0xE1),
        HairStrong = Rgb(0xDA, 0xD4, 0xCD),
        Ink = Rgb(0x1B, 0x1E, 0x26),
        Slate = Rgb(0x52, 0x50, 0x5B),
        Muted = Rgb(0x7C, 0x7A, 0x86),
        Coral = Rgb(0xF2, 0x91, 0x8C),
        Rose = Rgb(0xD9, 0x8A, 0xB7),
        Orchid = Rgb(0xC7, 0x7F, 0xD6),
        Success = Rgb(0x2E, 0x7D, 0x5B),
        Warn = Rgb(0xA8, 0x71, 0x2C),
        Danger = Rgb(0xC0, 0x51, 0x4B),
        OnInk = Rgb(0xFB, 0xFA, 0xF8),
    };

    public static readonly Palette Dark = new()
    {
        Paper = Rgb(0x15, 0x17, 0x1E),
        Sand = Rgb(0x1D, 0x20, 0x29),
        SandDeep = Rgb(0x23, 0x26, 0x31),
        Hair = Rgb(0x2A, 0x2D, 0x37),
        HairStrong = Rgb(0x3A, 0x3E, 0x4A),
        Ink = Rgb(0xF2, 0xF0, 0xEC),
        Slate = Rgb(0xB4, 0xB1, 0xBC),
        Muted = Rgb(0x8F, 0x8D, 0x9A),
        Coral = Rgb(0xF2, 0x91, 0x8C),
        Rose = Rgb(0xD9, 0x8A, 0xB7),
        Orchid = Rgb(0xC7, 0x7F, 0xD6),
        Success = Rgb(0x6C, 0xC9, 0xA0),
        Warn = Rgb(0xD8, 0xA6, 0x5B),
        Danger = Rgb(0xE3, 0x7A, 0x74),
        OnInk = Rgb(0x15, 0x17, 0x1E),
    };

    public static Palette For(CyreneTheme theme) => theme == CyreneTheme.Dark ? Dark : Light;
}
