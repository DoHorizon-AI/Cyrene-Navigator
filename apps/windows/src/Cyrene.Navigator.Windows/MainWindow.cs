// MainWindow.cs
//
// Window shell / 窗口外壳。
//
// This file is the boundary between the two layers the design keeps separate.
//
// Windows system layer — everything in this file: Mica backdrop, a real extended title bar with
// the system's caption buttons, the primary navigation rail, window sizing, and window-level
// keyboard accelerators. It should be obvious from the first frame that this is a Windows 11
// application.
//
// Cyrene product layer — everything the rail navigates to. Those views share no Windows-specific
// assumptions, which is what lets the same information architecture and visual language be
// rebuilt on macOS and Linux later.
//
// Windows 看起来像 Windows，Navigator 看起来始终像 Navigator —— 这个文件就是那条边界。

using System;
using Cyrene.Navigator.Windows.Controls;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Cyrene.Navigator.Windows.Views;
using Microsoft.UI;
using Microsoft.UI.Composition.SystemBackdrops;
using Microsoft.UI.Text;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Graphics;
using Windows.System;

namespace Cyrene.Navigator.Windows;

public sealed class MainWindow : Window
{
    private readonly Ports _ports = PortComposition.Create();

    private Grid _root = null!;
    private Grid _titleBar = null!;
    private Border _bodyHost = null!;
    private ColumnDefinition _captionSpacer = null!;
    private CyreneNavigation _nav = null!;
    private SessionsPage? _sessions;
    private TeachingTip? _tip;

    public MainWindow()
    {
        AppHost.Window = this;
        Title = "Cyrene Navigator";

        Diag.Log("window: chrome");
        ApplyWindowsChrome();

        Diag.Log("window: shell");
        Content = BuildShell();

        Diag.Log("window: ready");
        Activated += OnFirstActivation;
    }

    // -----------------------------------------------------------------------------------------
    // Windows system layer
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Mica, an extended title bar, retinted caption buttons and a sensible opening size. These
    /// are the cues that make an app feel native, and none of them are worth reimplementing.
    /// </summary>
    private void ApplyWindowsChrome()
    {
        // BaseAlt is the backdrop Windows itself uses for document-style apps; it lets the warm
        // paper canvas sit on top of the desktop's own tint at the window edges.
        SystemBackdrop = new MicaBackdrop { Kind = MicaKind.BaseAlt };

        ExtendsContentIntoTitleBar = true;

        var appWindow = AppWindow;
        if (appWindow is null)
        {
            return;
        }

        appWindow.Title = "Cyrene Navigator";
        appWindow.Resize(new SizeInt32(1560, 1000));

        if (appWindow.TitleBar is not null)
        {
            var bar = appWindow.TitleBar;
            bar.PreferredHeightOption = TitleBarHeightOption.Tall;
            bar.ButtonBackgroundColor = Colors.Transparent;
            bar.ButtonInactiveBackgroundColor = Colors.Transparent;
            bar.ButtonForegroundColor = Tk.Raw.Slate;
            bar.ButtonInactiveForegroundColor = Tk.Raw.Muted;
            bar.ButtonHoverBackgroundColor = Palette.Alpha(Tk.Raw.HairStrong, 0.5);
            bar.ButtonHoverForegroundColor = Tk.Raw.Ink;
            bar.ButtonPressedBackgroundColor = Palette.Alpha(Tk.Raw.HairStrong, 0.8);
            bar.ButtonPressedForegroundColor = Tk.Raw.Ink;
        }

        if (appWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = 1080;
            presenter.PreferredMinimumHeight = 720;
        }
    }

    private Grid BuildShell()
    {
        _root = new Grid();
        _root.RowDefinitions.Add(new RowDefinition { Height = Ui.Px(48) });
        _root.RowDefinitions.Add(new RowDefinition { Height = Ui.Star() });

        _titleBar = BuildTitleBar();
        _root.Children.Add(_titleBar.At(0, 0));
        SetTitleBar(_titleBar);

        Diag.Log("shell: title bar");

        var body = new Grid();
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        _nav = new CyreneNavigation();
        Diag.Log("shell: rail");
        _nav.Selected += Navigate;
        body.Children.Add(_nav.At(0));

        _bodyHost = new Border { Background = Tk.FillPaper };
        body.Children.Add(_bodyHost.At(1));

        _root.Children.Add(body.At(0, 1));

        RegisterAccelerators();
        Navigate(NavDestination.Sessions);
        return _root;
    }

    /// <summary>
    /// The title bar carries identity only. Everything in it is non-interactive, because a
    /// control inside the drag region would silently stop receiving input — so global actions
    /// live in the rail and in the page headers, where they belong anyway.
    /// </summary>
    private Grid BuildTitleBar()
    {
        var bar = new Grid { Background = Tk.FillTransparent };
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        bar.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        _captionSpacer = new ColumnDefinition { Width = Ui.Px(148) };
        bar.ColumnDefinitions.Add(_captionSpacer);

        var mark = Ui.SolidDiamond(8);
        mark.VerticalAlignment = VerticalAlignment.Center;

        var name = new TextBlock
        {
            Text = "CYRENE NAVIGATOR",
            FontFamily = Tk.Ty.Display,
            FontSize = 11,
            FontWeight = FontWeights.SemiBold,
            CharacterSpacing = 200,
            Foreground = Tk.Wash(Tk.Raw.Slate, 0.9),
            VerticalAlignment = VerticalAlignment.Center,
        };

        var workspace = new TextBlock
        {
            Text = "Example Workspace",
            FontFamily = Tk.Ty.Text,
            FontSize = 12,
            Foreground = Tk.Wash(Tk.Raw.Muted, 0.9),
            VerticalAlignment = VerticalAlignment.Center,
        };

        var separator = new Border
        {
            Width = 1,
            Height = 12,
            Background = Tk.Line,
            VerticalAlignment = VerticalAlignment.Center,
        };

        var identity = Ui.HStack(Tk.Sp.S10, mark, name, separator, workspace);
        identity.Margin = new Thickness(Tk.Sp.S16, 0, 0, 0);
        identity.IsHitTestVisible = false;

        bar.Children.Add(identity.At(0));
        return bar;
    }

    /// <summary>
    /// Window-level shortcuts. Ctrl+1..4 for destinations mirrors how Windows apps with a rail
    /// behave; Ctrl+L, Ctrl+M and Ctrl+R are the three things done most often in a session.
    /// </summary>
    private void RegisterAccelerators()
    {
        Add(VirtualKey.Number1, VirtualKeyModifiers.Control, () => _nav.Select(NavDestination.Sessions));
        Add(VirtualKey.Number2, VirtualKeyModifiers.Control, () => _nav.Select(NavDestination.Activity));
        Add(VirtualKey.Number3, VirtualKeyModifiers.Control, () => _nav.Select(NavDestination.Workspace));
        Add(VirtualKey.Number4, VirtualKeyModifiers.Control, () => _nav.Select(NavDestination.Settings));

        Add(VirtualKey.L, VirtualKeyModifiers.Control, () =>
        {
            _nav.Select(NavDestination.Sessions);
            _sessions?.Composer.FocusInput();
        });

        Add(VirtualKey.M, VirtualKeyModifiers.Control, () =>
        {
            _nav.Select(NavDestination.Sessions);
            _sessions?.Composer.OpenModelPicker();
        });

        Add(VirtualKey.B, VirtualKeyModifiers.Control, () => _nav.SetExpanded(false));

        void Add(VirtualKey key, VirtualKeyModifiers modifiers, Action action)
        {
            var accelerator = new KeyboardAccelerator { Key = key, Modifiers = modifiers };
            accelerator.Invoked += (_, e) =>
            {
                e.Handled = true;
                action();
            };
            _root.KeyboardAccelerators.Add(accelerator);
        }
    }

    // -----------------------------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------------------------

    private void Navigate(NavDestination destination)
    {
        Diag.Log("navigate: " + destination);

        switch (destination)
        {
            case NavDestination.Sessions:
                _sessions ??= new SessionsPage(_ports.Conversation, _ports.Agent, _ports.UiData);
                _bodyHost.Child = _sessions;
                break;

            case NavDestination.Activity:
                _bodyHost.Child = new ActivityPage(_ports.Agent, _ports.UiData);
                break;

            case NavDestination.Workspace:
                _bodyHost.Child = new WorkspacePage(_ports.UiData);
                break;

            default:
                _bodyHost.Child = new SettingsPage(ApplyTheme);
                break;
        }

        if (_bodyHost.Child is UIElement child)
        {
            Ui.FadeIn(child, 160);
        }
    }

    /// <summary>
    /// Re-tokenises and rebuilds. Proof that the token layer is the single source of truth: no
    /// view knows anything about themes, they just read tokens at construction.
    /// </summary>
    private void ApplyTheme(CyreneTheme theme)
    {
        if (theme == Tk.Theme)
        {
            return;
        }

        // The request arrives from inside a ComboBox event on the page that is about to be
        // replaced, so the rebuild has to happen after that event has finished unwinding.
        DispatcherQueue.TryEnqueue(() => RebuildForTheme(theme));
    }

    private void RebuildForTheme(CyreneTheme theme)
    {
        Tk.Use(theme);

        if (AppWindow?.TitleBar is not null)
        {
            AppWindow.TitleBar.ButtonForegroundColor = Tk.Raw.Slate;
            AppWindow.TitleBar.ButtonHoverForegroundColor = Tk.Raw.Ink;
            AppWindow.TitleBar.ButtonHoverBackgroundColor = Palette.Alpha(Tk.Raw.HairStrong, 0.5);
        }

        _sessions = null;
        _tip = null;
        Content = BuildShell();

        // Also tell the native controls which theme dictionary to resolve against, so stock
        // WinUI chrome (scroll bars, flyouts, dialogs) moves with the product tokens.
        _root.RequestedTheme = theme == CyreneTheme.Dark ? ElementTheme.Dark : ElementTheme.Light;
        _nav.Select(NavDestination.Settings);
    }

    // -----------------------------------------------------------------------------------------
    // First run
    // -----------------------------------------------------------------------------------------

    private void OnFirstActivation(object sender, WindowActivatedEventArgs args)
    {
        Activated -= OnFirstActivation;
        AlignCaptionSpacer();

        var captureFolder = DesignCapture.RequestedFolder();
        if (captureFolder is not null)
        {
            _ = RunCaptureAsync(captureFolder);
            return;
        }

        ShowFirstRunTip();
    }

    /// <summary>
    /// Walks the destinations and renders each to a PNG, then closes. Capture mode fills the
    /// title bar strip with the chrome colour because RenderTargetBitmap does not see the Mica
    /// backdrop behind it.
    /// </summary>
    private async System.Threading.Tasks.Task RunCaptureAsync(string folder)
    {
        Diag.Log("capture: begin " + folder);
        _titleBar.Background = Tk.FillSand;

        try
        {
            foreach (var (destination, name, note) in DesignCapture.Plan)
            {
                _nav.Select(destination);
                await DesignCapture.SettleAsync(1200);

                // The two extra transcript shots differ only in scroll position.
                if (name.StartsWith("02-", StringComparison.Ordinal) && _sessions is not null)
                {
                    _sessions.Conversation.RevealIndex(_sessions.Conversation.RowCount - 46);
                    await DesignCapture.SettleAsync(900);
                }
                else if (name.StartsWith("03-", StringComparison.Ordinal) && _sessions is not null)
                {
                    _sessions.Conversation.RevealIndex(_sessions.Conversation.RowCount - 20);
                    await DesignCapture.SettleAsync(900);
                }

                await DesignCapture.SaveAsync(_root, folder, name);
                Diag.Log("capture: " + name + " — " + note);
            }

            // The model picker lives in a popup, which the window render does not include, so it
            // is captured from its own presenter.
            if (_sessions is not null)
            {
                _nav.Select(NavDestination.Sessions);
                await DesignCapture.SettleAsync(700);
                _sessions.Composer.OpenModelPicker();
                await DesignCapture.SettleAsync(1100);

                var panel = _sessions.Composer.Model.PanelForCapture;
                if (panel is not null)
                {
                    await DesignCapture.SaveAsync(panel, folder, "07-model-selector");
                }
            }
        }
        catch (Exception ex)
        {
            Diag.Log("capture", ex);
        }

        Diag.Log("capture: done");
        Close();
    }

    /// <summary>
    /// Reserves exactly the width the system's caption buttons occupy, in DIPs. Hard-coding 148
    /// works at 100% scaling and drifts everywhere else.
    /// </summary>
    private void AlignCaptionSpacer()
    {
        var inset = AppWindow?.TitleBar?.RightInset ?? 0;
        var scale = Content?.XamlRoot?.RasterizationScale ?? 1.0;
        if (inset > 0 && scale > 0)
        {
            _captionSpacer.Width = Ui.Px(Math.Max(120, inset / scale));
        }
    }

    /// <summary>
    /// One teaching tip, once, about the single thing in this UI that is genuinely different
    /// from other clients: models are grouped by where they run, not by vendor.
    /// </summary>
    private void ShowFirstRunTip()
    {
        if (_sessions is null || _tip is not null)
        {
            return;
        }

        _tip = new TeachingTip
        {
            Title = "Models are grouped by where they run",
            Subtitle =
                "Hosted APIs, your workspace GPU pool and this device are all listed together. "
                + "Locality is what changes cost, latency and whether a prompt leaves your network.",
            PreferredPlacement = TeachingTipPlacementMode.Top,
            IsLightDismissEnabled = true,
            CloseButtonContent = "Got it",
            Target = _sessions.Composer.Model,
        };

        Grid.SetRow(_tip, 1);
        _root.Children.Add(_tip);

        var delay = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1400) };
        delay.Tick += (_, _) =>
        {
            delay.Stop();
            if (_tip is not null)
            {
                _tip.IsOpen = true;
            }
        };
        delay.Start();
    }
}
