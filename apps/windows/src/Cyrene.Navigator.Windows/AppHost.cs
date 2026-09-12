// AppHost.cs
//
// Window-scoped services / 窗口级服务。
//
// Unpackaged WinUI apps have to hand an HWND to any WinRT picker or dialog, and content dialogs
// need an XamlRoot. Centralising both here keeps that Windows-specific plumbing out of the
// product-layer controls, which is the same boundary the future macOS/Linux clients will need.

using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Storage.Pickers;

namespace Cyrene.Navigator.Windows;

public static class AppHost
{
    /// <summary>The single top-level window. Assigned once during startup.</summary>
    public static Window? Window { get; set; }

    public static XamlRoot? XamlRoot => Window?.Content?.XamlRoot;

    /// <summary>Native window handle, required by every WinRT picker in an unpackaged app.</summary>
    public static IntPtr Hwnd =>
        Window is null ? IntPtr.Zero : WinRT.Interop.WindowNative.GetWindowHandle(Window);

    /// <summary>Associates a WinRT picker with this window so it opens modally and centred.</summary>
    public static void Bind(object picker)
    {
        var hwnd = Hwnd;
        if (hwnd != IntPtr.Zero)
        {
            WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
        }
    }

    public static FileSavePicker SavePicker(string suggestedName, string extensionLabel, string extension)
    {
        var picker = new FileSavePicker
        {
            SuggestedStartLocation = PickerLocationId.DocumentsLibrary,
            SuggestedFileName = suggestedName,
        };
        picker.FileTypeChoices.Add(extensionLabel, new[] { extension });
        Bind(picker);
        return picker;
    }

    public static FileOpenPicker OpenPicker(params string[] extensions)
    {
        var picker = new FileOpenPicker
        {
            SuggestedStartLocation = PickerLocationId.ComputerFolder,
            ViewMode = PickerViewMode.List,
        };

        if (extensions.Length == 0)
        {
            picker.FileTypeFilter.Add("*");
        }
        else
        {
            foreach (var extension in extensions)
            {
                picker.FileTypeFilter.Add(extension);
            }
        }

        Bind(picker);
        return picker;
    }

    /// <summary>
    /// Shows a native ContentDialog wired to this window's XamlRoot. Returns false when there is
    /// no window yet, which only happens during startup.
    /// </summary>
    public static ContentDialog? Dialog(string title, UIElement content, string primary, string? secondary, string close)
    {
        var root = XamlRoot;
        if (root is null)
        {
            return null;
        }

        var dialog = new ContentDialog
        {
            XamlRoot = root,
            Title = title,
            Content = content,
            PrimaryButtonText = primary,
            CloseButtonText = close,
            DefaultButton = ContentDialogButton.Primary,
        };

        if (secondary is not null)
        {
            dialog.SecondaryButtonText = secondary;
        }

        return dialog;
    }
}
