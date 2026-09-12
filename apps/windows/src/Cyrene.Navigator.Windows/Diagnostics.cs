// Diagnostics.cs
//
// Startup logging / 启动日志。
//
// Unpackaged WinUI turns any failure during startup into an opaque STATUS_STOWED_EXCEPTION with
// no console output and nothing in the event log beyond an HRESULT. A prototype that is built
// and run by hand on other people's machines needs to be able to say what went wrong, so every
// startup phase is written to a log next to the executable.
//
// unpackaged WinUI 的启动失败不会输出任何有用信息，所以这里把每个启动阶段写到 exe 旁边的日志里。

using System;
using System.IO;

namespace Cyrene.Navigator.Windows;

public static class Diag
{
    private static readonly string LogPath =
        Path.Combine(AppContext.BaseDirectory, "cyrene-navigator.log");

    /// <summary>Appends one entry. Never throws: a failing logger must not mask the failure.</summary>
    public static void Log(string stage, Exception? error = null)
    {
        try
        {
            var line = error is null
                ? $"{DateTimeOffset.Now:HH:mm:ss.fff}  {stage}{Environment.NewLine}"
                : $"{DateTimeOffset.Now:HH:mm:ss.fff}  {stage}: {error.GetType().Name}: {error.Message}"
                  + $"{Environment.NewLine}{error}{Environment.NewLine}";
            File.AppendAllText(LogPath, line);
        }
        catch (Exception)
        {
            // Nothing sensible to do if even logging fails.
        }
    }

    /// <summary>Where the log lives, for error messages that need to point at it.</summary>
    public static string Path_ => LogPath;
}
