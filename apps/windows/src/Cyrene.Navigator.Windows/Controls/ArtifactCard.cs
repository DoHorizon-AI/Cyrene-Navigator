// Controls/ArtifactCard.cs
//
// Artifact / 产物卡片。
//
// An artifact outlives the conversation, so it is the one card allowed to be visually heavier
// than a message: a hairline card hung from a 1.5px gradient top edge — the trace handing
// something off. Everything else stays restrained: a real preview, a size, and three verbs.
//
// 产物是会话之外仍然存在的东西，所以它挂在一条渐变线下面 —— 视觉上就是"轨迹交付了什么"。

using System;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.Foundation;
using Windows.Storage;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class ArtifactCard : Grid
{
    private readonly ArtifactItem _item;

    public ArtifactCard(ArtifactItem item)
    {
        _item = item;

        var stack = new StackPanel { Orientation = Orientation.Vertical, Spacing = Tk.Sp.S10 };
        stack.Children.Add(BuildHeader());

        if (!string.IsNullOrWhiteSpace(item.Subtitle))
        {
            stack.Children.Add(Typo.Meta(item.Subtitle, Tk.TextSlate));
        }

        if (!string.IsNullOrWhiteSpace(item.Preview))
        {
            stack.Children.Add(BuildPreview());
        }

        if (item.Tags.Count > 0)
        {
            var tags = Ui.HStack(Tk.Sp.S6);
            foreach (var tag in item.Tags)
            {
                tags.Children.Add(Ui.Chip(tag));
            }

            stack.Children.Add(tags);
        }

        stack.Children.Add(BuildActions());

        var card = new Border
        {
            Background = Tk.FillPaper,
            BorderBrush = Tk.Line,
            BorderThickness = new Thickness(1, 0, 1, 1),
            CornerRadius = new CornerRadius(0, 0, 4, 4),
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12),
            Child = stack,
        };

        var edge = new Border
        {
            Height = 1.5,
            Background = Tk.Horizon,
            CornerRadius = new CornerRadius(2, 2, 0, 0),
        };

        Children.Add(Ui.VStack(0, edge, card));
        ContextFlyout = BuildContextMenu();
    }

    // -----------------------------------------------------------------------------------------

    private FrameworkElement BuildHeader()
    {
        var row = new Grid { ColumnSpacing = Tk.Sp.S10 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        row.Children.Add(Ui.KindChip(KindLabel(_item.Kind), Tk.Orchid).At(0));

        var title = Typo.Title(_item.Title, 15.5);
        title.VerticalAlignment = VerticalAlignment.Center;
        row.Children.Add(title.At(1));

        row.Children.Add(Typo.Mono(_item.SizeLabel, Tk.TextMuted, 11.5).WithAlignment().At(2));
        return row;
    }

    /// <summary>
    /// Preview with a paper-to-transparent fade over its lower edge, so a truncated preview reads
    /// as "there is more" instead of "this got cut off".
    /// </summary>
    private FrameworkElement BuildPreview()
    {
        var code = new CodeBlockView(
            _item.Preview,
            _item.PreviewLanguage,
            maxHeight: 116,
            showHeader: false,
            showLineNumbers: false);

        var fade = new Border
        {
            Height = 34,
            VerticalAlignment = VerticalAlignment.Bottom,
            IsHitTestVisible = false,
            Margin = new Thickness(1, 0, 1, 1),
            CornerRadius = new CornerRadius(0, 0, 4, 4),
        };

        var gradient = new LinearGradientBrush { StartPoint = new Point(0, 0), EndPoint = new Point(0, 1) };
        gradient.GradientStops.Add(new GradientStop { Offset = 0, Color = Palette.Alpha(Tk.Raw.SandDeep, 0) });
        gradient.GradientStops.Add(new GradientStop { Offset = 1, Color = Palette.Alpha(Tk.Raw.SandDeep, 0.96) });
        fade.Background = gradient;

        var host = new Grid();
        host.Children.Add(code);
        host.Children.Add(fade);
        return host;
    }

    private FrameworkElement BuildActions()
    {
        var open = Ui.Ghost("Open", "\uE8E5");
        open.Click += (_, _) => ShowOpenDialog();

        var save = Ui.Ghost("Save a copy…", "\uE74E");
        save.Click += (_, _) => SaveCopy();

        var copy = Ui.Ghost("Copy contents", "\uE8C8");
        copy.Click += (_, _) => CopyText(_item.Preview);

        var row = Ui.HStack(Tk.Sp.S4, open, save, copy);
        row.Margin = new Thickness(-Tk.Sp.S8, 0, 0, 0);
        return row;
    }

    private MenuFlyout BuildContextMenu()
    {
        var flyout = new MenuFlyout();

        var open = new MenuFlyoutItem { Text = "Open", Icon = new FontIcon { Glyph = "\uE8E5" } };
        open.Click += (_, _) => ShowOpenDialog();
        flyout.Items.Add(open);

        var save = new MenuFlyoutItem { Text = "Save a copy…", Icon = new FontIcon { Glyph = "\uE74E" } };
        save.Click += (_, _) => SaveCopy();
        flyout.Items.Add(save);

        flyout.Items.Add(new MenuFlyoutSeparator());

        var pin = new MenuFlyoutItem { Text = "Pin to project", Icon = new FontIcon { Glyph = "\uE718" } };
        flyout.Items.Add(pin);

        var reveal = new MenuFlyoutItem { Text = "Show in folder", Icon = new FontIcon { Glyph = "\uEC50" } };
        flyout.Items.Add(reveal);

        return flyout;
    }

    private async void ShowOpenDialog()
    {
        var body = Ui.VStack(Tk.Sp.S12,
            Typo.Meta(_item.Subtitle, Tk.TextSlate),
            new CodeBlockView(_item.Preview, _item.PreviewLanguage, maxHeight: 320, showHeader: false));

        var dialog = AppHost.Dialog(_item.Title, body, "Save a copy…", null, "Close");
        if (dialog is null)
        {
            return;
        }

        var result = await dialog.ShowAsync();
        if (result == ContentDialogResult.Primary)
        {
            SaveCopy();
        }
    }

    private async void SaveCopy()
    {
        try
        {
            var extension = _item.PreviewLanguage == "markdown" ? ".md" : ".txt";
            var picker = AppHost.SavePicker(_item.Title, "Artifact", extension);
            var file = await picker.PickSaveFileAsync();
            if (file is not null)
            {
                await FileIO.WriteTextAsync(file, _item.Preview);
            }
        }
        catch (Exception)
        {
            // The picker throws if the window handle is gone; nothing useful to report.
        }
    }

    private static void CopyText(string text)
    {
        try
        {
            var package = new DataPackage();
            package.SetText(text ?? string.Empty);
            Clipboard.SetContent(package);
        }
        catch (Exception)
        {
            // Ignored: transient clipboard ownership.
        }
    }

    private static string KindLabel(ArtifactKind kind) => kind switch
    {
        ArtifactKind.Document => "DOCUMENT",
        ArtifactKind.Code => "CODE",
        ArtifactKind.Data => "DATA",
        ArtifactKind.Diagram => "DIAGRAM",
        ArtifactKind.Image => "IMAGE",
        _ => "ARCHIVE",
    };
}
