// DesignCapture.cs
//
// Screenshot mode / 截图模式。
//
// `CyreneNavigator.exe --capture <folder>` walks the app through its destinations and renders
// each one to a PNG, then exits. It exists for two reasons:
//
//   · Design review needs current screenshots, and regenerating them by hand is the kind of
//     chore that stops happening.
//   · Synthesising mouse and keyboard input into a running app to drive it is fragile and
//     interferes with whatever the person at the keyboard is doing. Letting the app render
//     itself is deterministic and invisible.
//
// One fidelity caveat: RenderTargetBitmap captures the XAML tree, not the desktop compositor, so
// the Mica backdrop behind the title bar is not in these images. Capture mode fills that strip
// with the chrome fill instead, which is close to how Mica reads in place.
//
// 用 `--capture <目录>` 让应用自己把各个页面渲染成 PNG。不合成鼠标键盘输入，不干扰使用者。

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Cyrene.Navigator.Windows.Controls;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;

namespace Cyrene.Navigator.Windows;

public static class DesignCapture
{
    /// <summary>Reads the capture folder out of the command line, or null for normal startup.</summary>
    public static string? RequestedFolder()
    {
        var args = Environment.GetCommandLineArgs();
        for (var i = 1; i < args.Length; i++)
        {
            if (!string.Equals(args[i], "--capture", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            return i + 1 < args.Length ? args[i + 1] : AppContext.BaseDirectory;
        }

        return null;
    }

    /// <summary>Renders <paramref name="element"/> to a PNG. Returns false if it produced nothing.</summary>
    public static async Task<bool> SaveAsync(UIElement element, string folder, string name)
    {
        try
        {
            var bitmap = new RenderTargetBitmap();
            await bitmap.RenderAsync(element);

            if (bitmap.PixelWidth <= 0 || bitmap.PixelHeight <= 0)
            {
                Diag.Log($"capture {name}: nothing rendered");
                return false;
            }

            var buffer = await bitmap.GetPixelsAsync();
            var pixels = new byte[buffer.Length];
            using (var reader = DataReader.FromBuffer(buffer))
            {
                reader.ReadBytes(pixels);
            }

            var storage = await StorageFolder.GetFolderFromPathAsync(folder);
            var file = await storage.CreateFileAsync(name + ".png", CreationCollisionOption.ReplaceExisting);
            using var stream = await file.OpenAsync(FileAccessMode.ReadWrite);
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream);
            encoder.SetPixelData(
                BitmapPixelFormat.Bgra8,
                BitmapAlphaMode.Premultiplied,
                (uint)bitmap.PixelWidth,
                (uint)bitmap.PixelHeight,
                96,
                96,
                pixels);
            await encoder.FlushAsync();

            Diag.Log($"capture {name}: {bitmap.PixelWidth}x{bitmap.PixelHeight}");
            return true;
        }
        catch (Exception ex)
        {
            Diag.Log($"capture {name}", ex);
            return false;
        }
    }

    /// <summary>The shots a design review needs, in order.</summary>
    public static IReadOnlyList<(NavDestination Destination, string Name, string Note)> Plan { get; } =
        new List<(NavDestination, string, string)>
        {
            (NavDestination.Sessions, "01-conversation-live", "Run trace, running tool, blocked approval, streaming tail"),
            (NavDestination.Sessions, "02-transcript-prose", "Long markdown, tables, headings at the reading measure"),
            (NavDestination.Sessions, "03-transcript-tools", "Tool cards, failed connector, diff, artifact"),
            (NavDestination.Activity, "04-activity", "Long-running work, ordered by whether it needs you"),
            (NavDestination.Workspace, "05-workspace", "Resources as a spec sheet"),
            (NavDestination.Settings, "06-settings", "Native Windows settings experience"),
        };

    /// <summary>Waits for layout and entrance animations to settle before a shot.</summary>
    public static Task SettleAsync(int milliseconds = 900) => Task.Delay(milliseconds);
}
