// Core/Text/Markdown.cs
//
// Minimal block/inline markdown parser / 轻量 Markdown 解析器。
//
// Assistant turns are long-form prose, so the renderer needs a real block model rather than a
// string. Parsing is separated from rendering for one specific performance reason: a message is
// parsed exactly once and the block list is cached on the model, so scrolling a 120-message
// timeline never re-parses anything and streaming only re-parses the tail block.
//
// 覆盖范围：标题、段落、无序/有序列表、引用、分隔线、围栏代码块、表格，以及行内的粗体、
// 斜体、行内代码和链接。刻意不做完整 CommonMark —— 这是原型渲染需要的最小集合。

using System;
using System.Collections.Generic;
using System.Text;

namespace Cyrene.Navigator.Windows.Core.Text;

public enum MdBlockKind
{
    Paragraph,
    Heading,
    Bullets,
    Numbers,
    Code,
    Quote,
    Rule,
    Table,
}

public enum MdInlineKind
{
    Text,
    Strong,
    Emphasis,
    Code,
    Link,
}

/// <summary>One inline span. <see cref="Href"/> is only meaningful for links.</summary>
public sealed class MdInline
{
    public MdInlineKind Kind { get; init; } = MdInlineKind.Text;

    public string Text { get; init; } = string.Empty;

    public string? Href { get; init; }
}

/// <summary>A list item, or one table cell — both are just a run of inlines.</summary>
public sealed class MdLine
{
    public IReadOnlyList<MdInline> Inlines { get; init; } = Array.Empty<MdInline>();

    /// <summary>Indent depth for nested list items (0 or 1; deeper nesting is flattened).</summary>
    public int Depth { get; init; }

    /// <summary>Ordinal shown for numbered items.</summary>
    public int Ordinal { get; init; }

    /// <summary>Checkbox state for task list items; null when the item is not a task.</summary>
    public bool? Checked { get; init; }
}

public sealed class MdBlock
{
    public MdBlockKind Kind { get; init; }

    /// <summary>Heading level, 1..6.</summary>
    public int Level { get; init; }

    public IReadOnlyList<MdInline> Inlines { get; init; } = Array.Empty<MdInline>();

    public IReadOnlyList<MdLine> Items { get; init; } = Array.Empty<MdLine>();

    /// <summary>Raw source for code blocks.</summary>
    public string Code { get; init; } = string.Empty;

    public string Language { get; init; } = string.Empty;

    public IReadOnlyList<MdLine> TableHeader { get; init; } = Array.Empty<MdLine>();

    public IReadOnlyList<IReadOnlyList<MdLine>> TableRows { get; init; } =
        Array.Empty<IReadOnlyList<MdLine>>();
}

public static class Markdown
{
    /// <summary>
    /// Parses <paramref name="source"/> into a block list. Never throws: malformed input
    /// degrades to paragraphs, because a rendering crash inside a chat transcript is far worse
    /// than an imperfectly formatted paragraph.
    /// </summary>
    public static IReadOnlyList<MdBlock> Parse(string? source)
    {
        var blocks = new List<MdBlock>();
        if (string.IsNullOrEmpty(source))
        {
            return blocks;
        }

        try
        {
            ParseCore(source!.Replace("\r\n", "\n").Replace('\r', '\n'), blocks);
        }
        catch (Exception)
        {
            blocks.Clear();
            blocks.Add(new MdBlock { Kind = MdBlockKind.Paragraph, Inlines = new[] { new MdInline { Text = source ?? string.Empty } } });
        }

        return blocks;
    }

    private static void ParseCore(string text, List<MdBlock> blocks)
    {
        var lines = text.Split('\n');
        var i = 0;
        var paragraph = new List<string>();

        void FlushParagraph()
        {
            if (paragraph.Count == 0)
            {
                return;
            }

            blocks.Add(new MdBlock
            {
                Kind = MdBlockKind.Paragraph,
                Inlines = ParseInlines(string.Join(" ", paragraph)),
            });
            paragraph.Clear();
        }

        while (i < lines.Length)
        {
            var raw = lines[i];
            var line = raw.TrimEnd();
            var trimmed = line.TrimStart();

            // --- blank line: closes the current paragraph ---------------------------------
            if (trimmed.Length == 0)
            {
                FlushParagraph();
                i++;
                continue;
            }

            // --- fenced code block --------------------------------------------------------
            if (trimmed.StartsWith("```", StringComparison.Ordinal))
            {
                FlushParagraph();
                var language = trimmed[3..].Trim();
                var body = new StringBuilder();
                i++;
                while (i < lines.Length && !lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal))
                {
                    body.Append(lines[i]).Append('\n');
                    i++;
                }

                i++; // consume the closing fence (or fall off the end while streaming)
                blocks.Add(new MdBlock
                {
                    Kind = MdBlockKind.Code,
                    Language = NormaliseLanguage(language),
                    Code = body.ToString().TrimEnd('\n'),
                });
                continue;
            }

            // --- ATX heading ---------------------------------------------------------------
            if (trimmed.Length > 1 && trimmed[0] == '#')
            {
                var level = 0;
                while (level < trimmed.Length && trimmed[level] == '#')
                {
                    level++;
                }

                if (level <= 6 && level < trimmed.Length && trimmed[level] == ' ')
                {
                    FlushParagraph();
                    blocks.Add(new MdBlock
                    {
                        Kind = MdBlockKind.Heading,
                        Level = level,
                        Inlines = ParseInlines(trimmed[(level + 1)..].Trim()),
                    });
                    i++;
                    continue;
                }
            }

            // --- thematic break -------------------------------------------------------------
            if (IsRule(trimmed))
            {
                FlushParagraph();
                blocks.Add(new MdBlock { Kind = MdBlockKind.Rule });
                i++;
                continue;
            }

            // --- block quote ----------------------------------------------------------------
            if (trimmed.StartsWith("> ", StringComparison.Ordinal) || trimmed == ">")
            {
                FlushParagraph();
                var quote = new List<string>();
                while (i < lines.Length)
                {
                    var q = lines[i].TrimStart();
                    if (!q.StartsWith(">", StringComparison.Ordinal))
                    {
                        break;
                    }

                    quote.Add(q.Length > 1 ? q[1..].TrimStart() : string.Empty);
                    i++;
                }

                blocks.Add(new MdBlock
                {
                    Kind = MdBlockKind.Quote,
                    Inlines = ParseInlines(string.Join(" ", quote).Trim()),
                });
                continue;
            }

            // --- table -----------------------------------------------------------------------
            if (trimmed.StartsWith("|", StringComparison.Ordinal)
                && i + 1 < lines.Length
                && IsTableDivider(lines[i + 1]))
            {
                FlushParagraph();
                var header = SplitRow(trimmed);
                i += 2;
                var rows = new List<IReadOnlyList<MdLine>>();
                while (i < lines.Length && lines[i].TrimStart().StartsWith("|", StringComparison.Ordinal))
                {
                    rows.Add(SplitRow(lines[i].Trim()));
                    i++;
                }

                blocks.Add(new MdBlock { Kind = MdBlockKind.Table, TableHeader = header, TableRows = rows });
                continue;
            }

            // --- lists ------------------------------------------------------------------------
            if (IsBullet(trimmed) || IsNumbered(trimmed, out _))
            {
                FlushParagraph();
                var bulleted = IsBullet(trimmed);
                var items = new List<MdLine>();
                var ordinal = 1;

                while (i < lines.Length)
                {
                    var candidate = lines[i];
                    var body = candidate.TrimStart();
                    if (body.Length == 0)
                    {
                        // A single blank line inside a list is tolerated; two end it.
                        if (i + 1 < lines.Length && (IsBullet(lines[i + 1].TrimStart()) || IsNumbered(lines[i + 1].TrimStart(), out _)))
                        {
                            i++;
                            continue;
                        }

                        break;
                    }

                    var indent = candidate.Length - body.Length;
                    if (bulleted && IsBullet(body))
                    {
                        var content = body[2..];
                        bool? isChecked = null;
                        if (content.StartsWith("[ ] ", StringComparison.Ordinal))
                        {
                            isChecked = false;
                            content = content[4..];
                        }
                        else if (content.StartsWith("[x] ", StringComparison.OrdinalIgnoreCase))
                        {
                            isChecked = true;
                            content = content[4..];
                        }

                        items.Add(new MdLine
                        {
                            Inlines = ParseInlines(content.Trim()),
                            Depth = indent >= 2 ? 1 : 0,
                            Checked = isChecked,
                        });
                        i++;
                        continue;
                    }

                    if (!bulleted && IsNumbered(body, out var marker))
                    {
                        items.Add(new MdLine
                        {
                            Inlines = ParseInlines(body[marker..].Trim()),
                            Depth = indent >= 3 ? 1 : 0,
                            Ordinal = ordinal++,
                        });
                        i++;
                        continue;
                    }

                    // Continuation line of the previous item.
                    if (items.Count > 0 && indent >= 2)
                    {
                        var last = items[^1];
                        var merged = new List<MdInline>(last.Inlines);
                        merged.Add(new MdInline { Text = " " });
                        merged.AddRange(ParseInlines(body.Trim()));
                        items[^1] = new MdLine
                        {
                            Inlines = merged,
                            Depth = last.Depth,
                            Ordinal = last.Ordinal,
                            Checked = last.Checked,
                        };
                        i++;
                        continue;
                    }

                    break;
                }

                blocks.Add(new MdBlock
                {
                    Kind = bulleted ? MdBlockKind.Bullets : MdBlockKind.Numbers,
                    Items = items,
                });
                continue;
            }

            // --- plain paragraph text ---------------------------------------------------------
            paragraph.Add(trimmed);
            i++;
        }

        FlushParagraph();
    }

    // -----------------------------------------------------------------------------------------
    // Inline scanning
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Single-pass inline scanner. Order matters: inline code wins over emphasis so that
    /// <c>`a * b`</c> does not turn into italics.
    /// </summary>
    public static IReadOnlyList<MdInline> ParseInlines(string text)
    {
        var result = new List<MdInline>();
        if (string.IsNullOrEmpty(text))
        {
            return result;
        }

        var buffer = new StringBuilder();
        var i = 0;

        void Flush()
        {
            if (buffer.Length > 0)
            {
                result.Add(new MdInline { Text = buffer.ToString() });
                buffer.Clear();
            }
        }

        while (i < text.Length)
        {
            var c = text[i];

            // inline code
            if (c == '`')
            {
                var end = text.IndexOf('`', i + 1);
                if (end > i + 1)
                {
                    Flush();
                    result.Add(new MdInline { Kind = MdInlineKind.Code, Text = text[(i + 1)..end] });
                    i = end + 1;
                    continue;
                }
            }

            // strong
            if (c == '*' && i + 1 < text.Length && text[i + 1] == '*')
            {
                var end = text.IndexOf("**", i + 2, StringComparison.Ordinal);
                if (end > i + 2)
                {
                    Flush();
                    result.Add(new MdInline { Kind = MdInlineKind.Strong, Text = text[(i + 2)..end] });
                    i = end + 2;
                    continue;
                }
            }

            // emphasis
            if ((c == '*' || c == '_') && i + 1 < text.Length && text[i + 1] != ' ')
            {
                var end = text.IndexOf(c, i + 1);
                if (end > i + 1 && text[end - 1] != ' ')
                {
                    Flush();
                    result.Add(new MdInline { Kind = MdInlineKind.Emphasis, Text = text[(i + 1)..end] });
                    i = end + 1;
                    continue;
                }
            }

            // link
            if (c == '[')
            {
                var close = text.IndexOf(']', i + 1);
                if (close > i && close + 1 < text.Length && text[close + 1] == '(')
                {
                    var hrefEnd = text.IndexOf(')', close + 2);
                    if (hrefEnd > close + 2)
                    {
                        Flush();
                        result.Add(new MdInline
                        {
                            Kind = MdInlineKind.Link,
                            Text = text[(i + 1)..close],
                            Href = text[(close + 2)..hrefEnd],
                        });
                        i = hrefEnd + 1;
                        continue;
                    }
                }
            }

            buffer.Append(c);
            i++;
        }

        Flush();
        return result;
    }

    // -----------------------------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------------------------

    private static bool IsBullet(string s) =>
        s.Length >= 2 && (s[0] == '-' || s[0] == '*' || s[0] == '+') && s[1] == ' ';

    private static bool IsNumbered(string s, out int markerLength)
    {
        markerLength = 0;
        var digits = 0;
        while (digits < s.Length && char.IsDigit(s[digits]))
        {
            digits++;
        }

        if (digits == 0 || digits + 1 >= s.Length)
        {
            return false;
        }

        if ((s[digits] == '.' || s[digits] == ')') && s[digits + 1] == ' ')
        {
            markerLength = digits + 2;
            return true;
        }

        return false;
    }

    private static bool IsRule(string s)
    {
        if (s.Length < 3)
        {
            return false;
        }

        var c = s[0];
        if (c != '-' && c != '*' && c != '_')
        {
            return false;
        }

        foreach (var ch in s)
        {
            if (ch != c && ch != ' ')
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsTableDivider(string s)
    {
        var t = s.Trim();
        if (!t.StartsWith("|", StringComparison.Ordinal))
        {
            return false;
        }

        var seenDash = false;
        foreach (var ch in t)
        {
            if (ch == '-')
            {
                seenDash = true;
            }
            else if (ch != '|' && ch != ' ' && ch != ':')
            {
                return false;
            }
        }

        return seenDash;
    }

    private static IReadOnlyList<MdLine> SplitRow(string row)
    {
        var trimmed = row.Trim().Trim('|');
        var cells = trimmed.Split('|');
        var result = new List<MdLine>(cells.Length);
        foreach (var cell in cells)
        {
            result.Add(new MdLine { Inlines = ParseInlines(cell.Trim()) });
        }

        return result;
    }

    /// <summary>Maps common fence aliases onto the tokenizer's language identifiers.</summary>
    public static string NormaliseLanguage(string language)
    {
        var l = language.Trim().ToLowerInvariant();
        return l switch
        {
            "py" or "python3" => "python",
            "rs" => "rust",
            "sh" or "shell" or "zsh" or "console" => "bash",
            "cs" or "c#" => "csharp",
            "ts" or "tsx" => "typescript",
            "js" or "jsx" => "javascript",
            "yml" => "yaml",
            "" => "text",
            _ => l,
        };
    }

    /// <summary>Plain-text projection of an inline run, for previews and tooltips.</summary>
    public static string Flatten(IReadOnlyList<MdInline> inlines)
    {
        var sb = new StringBuilder();
        foreach (var inline in inlines)
        {
            sb.Append(inline.Text);
        }

        return sb.ToString();
    }
}
