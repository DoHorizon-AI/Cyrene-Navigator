// Core/StreamingScript.cs
//
// Deterministic stream cursor / 确定性流式光标。
//
// This is a UI-neutral product contract fixture. The native UI only consumes its state and can
// later receive the same incremental text from a real API adapter.

using System;

namespace Cyrene.Navigator.Windows.Core;

public sealed class StreamingScript
{
    private readonly string _full;
    private int _cursor;

    public StreamingScript(string full)
    {
        _full = full;
    }

    public bool Done => _cursor >= _full.Length;

    public string Visible => _full[.._cursor];

    /// <summary>Reveals roughly <paramref name="chars"/> more characters, snapping to a word end.</summary>
    public bool Advance(int chars)
    {
        if (Done)
        {
            return false;
        }

        var next = Math.Min(_full.Length, _cursor + chars);
        while (next < _full.Length && !char.IsWhiteSpace(_full[next]))
        {
            next++;
        }

        _cursor = next;
        return true;
    }

    public void Reset() => _cursor = 0;
}
