// Core/Text/CodeTokenizer.cs
//
// Line-oriented syntax tokenizer / 按行输出的语法着色分词器。
//
// Output is one token list *per line* rather than per file. That shape is deliberate: the code
// block view renders line by line, can show gutter numbers, and can cap its own height without
// having to re-tokenize. Tokenizing is done once and cached on the timeline model.
//
// 语言覆盖：python / rust / json / bash / csharp / typescript / yaml / toml / sql / diff，
// 其余语言退化为中性着色。分词器只服务于"看得清"，不追求语义正确。

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Text;

public enum CodeTokenKind
{
    Plain,
    Keyword,
    Type,
    Str,
    Number,
    Comment,
    Function,
    Punct,
    Meta,

    /// <summary>Diff-only: an added line.</summary>
    DiffAdd,

    /// <summary>Diff-only: a removed line.</summary>
    DiffDel,

    /// <summary>Diff-only: an <c>@@</c> hunk header.</summary>
    DiffHunk,
}

public readonly struct CodeToken
{
    public CodeToken(CodeTokenKind kind, string text)
    {
        Kind = kind;
        Text = text;
    }

    public CodeTokenKind Kind { get; }

    public string Text { get; }
}

/// <summary>Tokenized source: outer list is lines, inner list is spans within that line.</summary>
public sealed class TokenizedCode
{
    public IReadOnlyList<IReadOnlyList<CodeToken>> Lines { get; init; } =
        Array.Empty<IReadOnlyList<CodeToken>>();

    public int LineCount => Lines.Count;

    /// <summary>Longest line in characters, used to decide whether to allow horizontal scroll.</summary>
    public int WidestLine { get; init; }
}

public static class CodeTokenizer
{
    private sealed class Grammar
    {
        public string[] LineComment { get; init; } = Array.Empty<string>();

        public bool BlockComment { get; init; }

        public char[] StringDelimiters { get; init; } = { '"', '\'' };

        public bool TripleQuotes { get; init; }

        public HashSet<string> Keywords { get; init; } = new(StringComparer.Ordinal);

        public HashSet<string> Types { get; init; } = new(StringComparer.Ordinal);

        /// <summary>Prefix that marks an attribute/decorator line, e.g. <c>@</c> or <c>#[</c>.</summary>
        public char[] MetaPrefix { get; init; } = Array.Empty<char>();
    }

    private static readonly Grammar Python = new()
    {
        LineComment = new[] { "#" },
        TripleQuotes = true,
        MetaPrefix = new[] { '@' },
        Keywords = new(StringComparer.Ordinal)
        {
            "def", "class", "return", "if", "elif", "else", "for", "while", "in", "not", "and",
            "or", "import", "from", "as", "with", "try", "except", "finally", "raise", "yield",
            "async", "await", "lambda", "pass", "break", "continue", "global", "nonlocal",
            "assert", "del", "is", "None", "True", "False", "self", "match", "case",
        },
        Types = new(StringComparer.Ordinal)
        {
            "int", "str", "float", "bool", "bytes", "list", "dict", "set", "tuple", "Any",
            "Optional", "Sequence", "Iterable", "Mapping", "Callable", "Path", "datetime",
        },
    };

    private static readonly Grammar Rust = new()
    {
        LineComment = new[] { "//" },
        BlockComment = true,
        MetaPrefix = new[] { '#' },
        Keywords = new(StringComparer.Ordinal)
        {
            "fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "for",
            "while", "loop", "if", "else", "match", "return", "pub", "use", "mod", "crate",
            "self", "super", "as", "where", "async", "await", "move", "ref", "dyn", "unsafe",
            "type", "in", "break", "continue", "true", "false", "Self",
        },
        Types = new(StringComparer.Ordinal)
        {
            "String", "str", "Vec", "Option", "Result", "Box", "Arc", "Rc", "RefCell", "Mutex",
            "HashMap", "HashSet", "u8", "u16", "u32", "u64", "usize", "i8", "i16", "i32", "i64",
            "isize", "f32", "f64", "bool", "char", "Duration", "Instant", "Path", "PathBuf",
            "Ok", "Err", "Some", "None",
        },
    };

    private static readonly Grammar CSharp = new()
    {
        LineComment = new[] { "//" },
        BlockComment = true,
        MetaPrefix = new[] { '[' },
        Keywords = new(StringComparer.Ordinal)
        {
            "using", "namespace", "class", "struct", "record", "interface", "enum", "public",
            "private", "protected", "internal", "static", "readonly", "sealed", "abstract",
            "virtual", "override", "new", "return", "if", "else", "for", "foreach", "while",
            "switch", "case", "break", "continue", "var", "async", "await", "get", "set", "init",
            "true", "false", "null", "this", "base", "throw", "try", "catch", "finally", "in",
            "out", "ref", "params", "is", "as", "when", "yield", "partial", "const",
        },
        Types = new(StringComparer.Ordinal)
        {
            "string", "int", "long", "double", "float", "bool", "byte", "char", "object", "void",
            "Task", "List", "Dictionary", "IEnumerable", "IReadOnlyList", "Span", "DateTimeOffset",
            "TimeSpan", "Guid", "Exception",
        },
    };

    private static readonly Grammar Bash = new()
    {
        LineComment = new[] { "#" },
        Keywords = new(StringComparer.Ordinal)
        {
            "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case",
            "esac", "function", "return", "export", "local", "set", "source", "exit", "cd",
            "echo", "sudo",
        },
        Types = new(StringComparer.Ordinal)
        {
            "cargo", "git", "python", "uv", "pytest", "npm", "pnpm", "dotnet", "rg", "curl",
            "docker", "kubectl", "make", "ruff", "mypy",
        },
    };

    private static readonly Grammar TypeScript = new()
    {
        LineComment = new[] { "//" },
        BlockComment = true,
        StringDelimiters = new[] { '"', '\'', '`' },
        MetaPrefix = new[] { '@' },
        Keywords = new(StringComparer.Ordinal)
        {
            "import", "from", "export", "default", "const", "let", "var", "function", "return",
            "if", "else", "for", "while", "class", "extends", "implements", "interface", "type",
            "enum", "new", "await", "async", "try", "catch", "finally", "throw", "of", "in",
            "true", "false", "null", "undefined", "this", "as", "readonly", "public", "private",
        },
        Types = new(StringComparer.Ordinal)
        {
            "string", "number", "boolean", "void", "unknown", "any", "never", "Promise", "Array",
            "Record", "Partial", "Map", "Set",
        },
    };

    private static readonly Grammar Sql = new()
    {
        LineComment = new[] { "--" },
        Keywords = new(StringComparer.OrdinalIgnoreCase)
        {
            "select", "from", "where", "join", "left", "inner", "outer", "on", "group", "by",
            "order", "having", "limit", "insert", "into", "values", "update", "set", "delete",
            "create", "table", "index", "with", "as", "and", "or", "not", "null", "distinct",
            "case", "when", "then", "else", "end", "desc", "asc",
        },
    };

    private static readonly Grammar Generic = new()
    {
        LineComment = new[] { "#", "//" },
        Keywords = new(StringComparer.Ordinal) { "true", "false", "null" },
    };

    /// <summary>
    /// Tokenizes <paramref name="code"/>. Unknown languages fall back to neutral colouring,
    /// which is preferable to guessing wrong and colouring prose as keywords.
    /// </summary>
    public static TokenizedCode Tokenize(string? code, string? language)
    {
        var text = (code ?? string.Empty).Replace("\r\n", "\n").Replace('\r', '\n');
        var rawLines = text.Split('\n');
        var lang = (language ?? "text").Trim().ToLowerInvariant();

        var lines = new List<IReadOnlyList<CodeToken>>(rawLines.Length);
        var widest = 0;

        try
        {
            if (lang == "diff" || lang == "patch")
            {
                foreach (var line in rawLines)
                {
                    lines.Add(TokenizeDiffLine(line));
                    widest = Math.Max(widest, line.Length);
                }
            }
            else if (lang == "json")
            {
                foreach (var line in rawLines)
                {
                    lines.Add(TokenizeJsonLine(line));
                    widest = Math.Max(widest, line.Length);
                }
            }
            else if (lang is "yaml" or "toml" or "ini" or "properties")
            {
                foreach (var line in rawLines)
                {
                    lines.Add(TokenizeKeyValueLine(line));
                    widest = Math.Max(widest, line.Length);
                }
            }
            else
            {
                var grammar = GrammarFor(lang);
                var inBlockComment = false;
                var inTripleQuote = false;
                foreach (var line in rawLines)
                {
                    lines.Add(TokenizeLine(line, grammar, ref inBlockComment, ref inTripleQuote));
                    widest = Math.Max(widest, line.Length);
                }
            }
        }
        catch (Exception)
        {
            lines.Clear();
            foreach (var line in rawLines)
            {
                lines.Add(new[] { new CodeToken(CodeTokenKind.Plain, line) });
            }
        }

        return new TokenizedCode { Lines = lines, WidestLine = widest };
    }

    private static Grammar GrammarFor(string lang) => lang switch
    {
        "python" => Python,
        "rust" => Rust,
        "csharp" => CSharp,
        "bash" => Bash,
        "typescript" or "javascript" => TypeScript,
        "sql" => Sql,
        _ => Generic,
    };

    // -----------------------------------------------------------------------------------------
    // General-purpose line scanner
    // -----------------------------------------------------------------------------------------

    private static IReadOnlyList<CodeToken> TokenizeLine(
        string line,
        Grammar grammar,
        ref bool inBlockComment,
        ref bool inTripleQuote)
    {
        var tokens = new List<CodeToken>();
        if (line.Length == 0)
        {
            return tokens;
        }

        // Multi-line states swallow the whole line until their terminator appears.
        if (inBlockComment)
        {
            var close = line.IndexOf("*/", StringComparison.Ordinal);
            if (close < 0)
            {
                tokens.Add(new CodeToken(CodeTokenKind.Comment, line));
                return tokens;
            }

            tokens.Add(new CodeToken(CodeTokenKind.Comment, line[..(close + 2)]));
            inBlockComment = false;
            var restState = false;
            var rest = TokenizeLine(line[(close + 2)..], grammar, ref restState, ref inTripleQuote);
            tokens.AddRange(rest);
            return tokens;
        }

        if (inTripleQuote)
        {
            var close = line.IndexOf("\"\"\"", StringComparison.Ordinal);
            if (close < 0)
            {
                tokens.Add(new CodeToken(CodeTokenKind.Str, line));
                return tokens;
            }

            tokens.Add(new CodeToken(CodeTokenKind.Str, line[..(close + 3)]));
            inTripleQuote = false;
            var blockState = false;
            tokens.AddRange(TokenizeLine(line[(close + 3)..], grammar, ref blockState, ref inTripleQuote));
            return tokens;
        }

        var i = 0;
        var plain = new System.Text.StringBuilder();

        void Flush()
        {
            if (plain.Length > 0)
            {
                tokens.Add(new CodeToken(CodeTokenKind.Plain, plain.ToString()));
                plain.Clear();
            }
        }

        while (i < line.Length)
        {
            // line comment
            var isComment = false;
            foreach (var marker in grammar.LineComment)
            {
                if (i + marker.Length <= line.Length && string.CompareOrdinal(line, i, marker, 0, marker.Length) == 0)
                {
                    Flush();
                    tokens.Add(new CodeToken(CodeTokenKind.Comment, line[i..]));
                    isComment = true;
                    break;
                }
            }

            if (isComment)
            {
                return tokens;
            }

            // block comment open
            if (grammar.BlockComment && i + 1 < line.Length && line[i] == '/' && line[i + 1] == '*')
            {
                Flush();
                var close = line.IndexOf("*/", i + 2, StringComparison.Ordinal);
                if (close < 0)
                {
                    tokens.Add(new CodeToken(CodeTokenKind.Comment, line[i..]));
                    inBlockComment = true;
                    return tokens;
                }

                tokens.Add(new CodeToken(CodeTokenKind.Comment, line[i..(close + 2)]));
                i = close + 2;
                continue;
            }

            // python triple-quoted string
            if (grammar.TripleQuotes && i + 2 < line.Length && line[i] == '"' && line[i + 1] == '"' && line[i + 2] == '"')
            {
                Flush();
                var close = line.IndexOf("\"\"\"", i + 3, StringComparison.Ordinal);
                if (close < 0)
                {
                    tokens.Add(new CodeToken(CodeTokenKind.Str, line[i..]));
                    inTripleQuote = true;
                    return tokens;
                }

                tokens.Add(new CodeToken(CodeTokenKind.Str, line[i..(close + 3)]));
                i = close + 3;
                continue;
            }

            // string literal
            if (Array.IndexOf(grammar.StringDelimiters, line[i]) >= 0)
            {
                Flush();
                var quote = line[i];
                var j = i + 1;
                while (j < line.Length)
                {
                    if (line[j] == '\\')
                    {
                        j += 2;
                        continue;
                    }

                    if (line[j] == quote)
                    {
                        j++;
                        break;
                    }

                    j++;
                }

                var end = Math.Min(j, line.Length);
                tokens.Add(new CodeToken(CodeTokenKind.Str, line[i..end]));
                i = end;
                continue;
            }

            // attribute / decorator
            if (Array.IndexOf(grammar.MetaPrefix, line[i]) >= 0 && i + 1 < line.Length
                && (char.IsLetter(line[i + 1]) || line[i + 1] == '[' || line[i + 1] == '_'))
            {
                Flush();
                var j = i + 1;
                while (j < line.Length && (char.IsLetterOrDigit(line[j]) || line[j] is '_' or '.' or '[' or ']' or '(' or ')' or '"' or '\'' or '=' or ',' or ' '))
                {
                    if (line[j] == ' ' && line[i] != '[')
                    {
                        break;
                    }

                    j++;
                }

                tokens.Add(new CodeToken(CodeTokenKind.Meta, line[i..j]));
                i = j;
                continue;
            }

            // number
            if (char.IsDigit(line[i]) && (i == 0 || !char.IsLetterOrDigit(line[i - 1]) && line[i - 1] != '_'))
            {
                Flush();
                var j = i;
                while (j < line.Length && (char.IsLetterOrDigit(line[j]) || line[j] == '.' || line[j] == '_'))
                {
                    j++;
                }

                tokens.Add(new CodeToken(CodeTokenKind.Number, line[i..j]));
                i = j;
                continue;
            }

            // identifier
            if (char.IsLetter(line[i]) || line[i] == '_')
            {
                var j = i;
                while (j < line.Length && (char.IsLetterOrDigit(line[j]) || line[j] == '_'))
                {
                    j++;
                }

                var word = line[i..j];
                Flush();
                if (grammar.Keywords.Contains(word))
                {
                    tokens.Add(new CodeToken(CodeTokenKind.Keyword, word));
                }
                else if (grammar.Types.Contains(word))
                {
                    tokens.Add(new CodeToken(CodeTokenKind.Type, word));
                }
                else if (j < line.Length && line[j] == '(')
                {
                    tokens.Add(new CodeToken(CodeTokenKind.Function, word));
                }
                else if (word.Length > 1 && char.IsUpper(word[0]) && HasLower(word))
                {
                    // Heuristic: PascalCase identifiers read as types in every language here.
                    tokens.Add(new CodeToken(CodeTokenKind.Type, word));
                }
                else
                {
                    tokens.Add(new CodeToken(CodeTokenKind.Plain, word));
                }

                i = j;
                continue;
            }

            // punctuation
            if (!char.IsWhiteSpace(line[i]) && !char.IsLetterOrDigit(line[i]))
            {
                Flush();
                tokens.Add(new CodeToken(CodeTokenKind.Punct, line[i].ToString()));
                i++;
                continue;
            }

            plain.Append(line[i]);
            i++;
        }

        Flush();
        return tokens;
    }

    private static bool HasLower(string word)
    {
        foreach (var c in word)
        {
            if (char.IsLower(c))
            {
                return true;
            }
        }

        return false;
    }

    // -----------------------------------------------------------------------------------------
    // Specialised scanners
    // -----------------------------------------------------------------------------------------

    private static IReadOnlyList<CodeToken> TokenizeJsonLine(string line)
    {
        var tokens = new List<CodeToken>();
        var i = 0;
        while (i < line.Length)
        {
            var c = line[i];
            if (c == '"')
            {
                var j = i + 1;
                while (j < line.Length)
                {
                    if (line[j] == '\\')
                    {
                        j += 2;
                        continue;
                    }

                    if (line[j] == '"')
                    {
                        j++;
                        break;
                    }

                    j++;
                }

                var end = Math.Min(j, line.Length);
                // A string immediately followed by ':' is a key, not a value.
                var k = end;
                while (k < line.Length && line[k] == ' ')
                {
                    k++;
                }

                var isKey = k < line.Length && line[k] == ':';
                tokens.Add(new CodeToken(isKey ? CodeTokenKind.Meta : CodeTokenKind.Str, line[i..end]));
                i = end;
                continue;
            }

            if (char.IsDigit(c) || (c == '-' && i + 1 < line.Length && char.IsDigit(line[i + 1])))
            {
                var j = i + 1;
                while (j < line.Length && (char.IsDigit(line[j]) || line[j] is '.' or 'e' or 'E' or '+' or '-'))
                {
                    j++;
                }

                tokens.Add(new CodeToken(CodeTokenKind.Number, line[i..j]));
                i = j;
                continue;
            }

            if (char.IsLetter(c))
            {
                var j = i;
                while (j < line.Length && char.IsLetter(line[j]))
                {
                    j++;
                }

                var word = line[i..j];
                tokens.Add(new CodeToken(
                    word is "true" or "false" or "null" ? CodeTokenKind.Keyword : CodeTokenKind.Plain,
                    word));
                i = j;
                continue;
            }

            if (char.IsWhiteSpace(c))
            {
                var j = i;
                while (j < line.Length && char.IsWhiteSpace(line[j]))
                {
                    j++;
                }

                tokens.Add(new CodeToken(CodeTokenKind.Plain, line[i..j]));
                i = j;
                continue;
            }

            tokens.Add(new CodeToken(CodeTokenKind.Punct, c.ToString()));
            i++;
        }

        return tokens;
    }

    private static IReadOnlyList<CodeToken> TokenizeKeyValueLine(string line)
    {
        var tokens = new List<CodeToken>();
        var trimmed = line.TrimStart();
        if (trimmed.StartsWith("#", StringComparison.Ordinal))
        {
            tokens.Add(new CodeToken(CodeTokenKind.Comment, line));
            return tokens;
        }

        if (trimmed.StartsWith("[", StringComparison.Ordinal))
        {
            tokens.Add(new CodeToken(CodeTokenKind.Meta, line));
            return tokens;
        }

        var separator = line.IndexOfAny(new[] { ':', '=' });
        if (separator <= 0)
        {
            tokens.Add(new CodeToken(CodeTokenKind.Plain, line));
            return tokens;
        }

        tokens.Add(new CodeToken(CodeTokenKind.Meta, line[..separator]));
        tokens.Add(new CodeToken(CodeTokenKind.Punct, line[separator].ToString()));

        var value = line[(separator + 1)..];
        var kind = CodeTokenKind.Str;
        var probe = value.Trim();
        if (probe.Length == 0)
        {
            kind = CodeTokenKind.Plain;
        }
        else if (double.TryParse(probe, out _))
        {
            kind = CodeTokenKind.Number;
        }
        else if (probe is "true" or "false" or "null" or "~")
        {
            kind = CodeTokenKind.Keyword;
        }

        tokens.Add(new CodeToken(kind, value));
        return tokens;
    }

    private static IReadOnlyList<CodeToken> TokenizeDiffLine(string line)
    {
        if (line.StartsWith("@@", StringComparison.Ordinal))
        {
            return new[] { new CodeToken(CodeTokenKind.DiffHunk, line) };
        }

        if (line.StartsWith("+++", StringComparison.Ordinal) || line.StartsWith("---", StringComparison.Ordinal))
        {
            return new[] { new CodeToken(CodeTokenKind.Meta, line) };
        }

        if (line.StartsWith("+", StringComparison.Ordinal))
        {
            return new[] { new CodeToken(CodeTokenKind.DiffAdd, line) };
        }

        if (line.StartsWith("-", StringComparison.Ordinal))
        {
            return new[] { new CodeToken(CodeTokenKind.DiffDel, line) };
        }

        return new[] { new CodeToken(CodeTokenKind.Plain, line) };
    }
}
