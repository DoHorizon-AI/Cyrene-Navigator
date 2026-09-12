// Controls/Composer.cs
//
// Composer / 输入区。
//
// One input, no mode switcher. Modes force the user to classify their intent before they have
// expressed it; instead what changes is the *context strip* above the input — model, agent,
// which roots the tools may touch. Capability appears because it is relevant, not because it
// exists.
//
// The composer is also where the trace terminates: when a run is live, a hairline gradient
// enters the top edge of the composer, so the line that started in the transcript visibly
// arrives at the place you can interrupt it.
//
// 一个输入框，不做模式切换。变化的是上方的上下文条（模型 / agent / 可访问范围）。

using System;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.System;
using Windows.UI.Core;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class Composer : Grid
{
    private readonly TextBox _input;
    private readonly Button _primary;
    private readonly Border _liveEdge;
    private readonly TextBlock _runningLabel;
    private readonly ModelSelector _model;
    private bool _running;

    /// <summary>Raised when the user submits. The payload is the trimmed text.</summary>
    public event Action<string>? Submitted;

    public event Action? StopRequested;

    public event Action<ModelDescriptor>? ModelChanged;

    public ModelSelector Model => _model;

    public Composer(ModelDescriptor initialModel, INavigatorUiData data)
    {
        _model = new ModelSelector(initialModel, data);
        _model.Changed += m => ModelChanged?.Invoke(m);

        _input = BuildInput();
        _runningLabel = Typo.Label("running", Tk.Coral);
        Ui.Breathe(_runningLabel, 0.45, 1);
        _runningLabel.Visibility = Visibility.Collapsed;

        _primary = BuildPrimary();

        _liveEdge = new Border
        {
            Height = 1.5,
            Background = Tk.Horizon,
            VerticalAlignment = VerticalAlignment.Top,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Margin = new Thickness(1, 0, 1, 0),
            CornerRadius = new CornerRadius(1),
            Opacity = 0,
            IsHitTestVisible = false,
        };

        var stack = new StackPanel { Orientation = Orientation.Vertical };
        stack.Children.Add(_input);
        stack.Children.Add(BuildContextStrip());

        var card = new Border
        {
            Background = Tk.FillPaper,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Lg,
            Child = stack,
        };

        // The TextBox has no border of its own, so the focus indicator belongs to the whole
        // composer. Orchid, matching the website's focus-visible outline and the focus rings on
        // every native control in the app.
        _input.GotFocus += (_, _) => card.BorderBrush = Tk.Wash(Tk.Raw.Orchid, 0.85);
        _input.LostFocus += (_, _) => card.BorderBrush = Tk.Line;

        var host = new Grid();
        host.Children.Add(card);
        host.Children.Add(_liveEdge);

        Children.Add(host);
    }

    // -----------------------------------------------------------------------------------------

    private TextBox BuildInput()
    {
        var input = new TextBox
        {
            PlaceholderText = "Ask, or describe what you want changed…",
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            FontFamily = Tk.Ty.Text,
            FontSize = 14,
            Background = Tk.FillTransparent,
            BorderThickness = Tk.Ln.None,
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S8),
            MinHeight = 64,
            MaxHeight = 200,
            CornerRadius = Tk.Rad.Lg,
            TextAlignment = TextAlignment.Left,
        };

        // Enter sends, Shift+Enter and Ctrl+Enter insert a newline — the convention this
        // audience already has in their fingers.
        input.KeyDown += (_, e) =>
        {
            if (e.Key != VirtualKey.Enter)
            {
                return;
            }

            var shift = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift);
            var control = InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control);
            var modified = shift.HasFlag(CoreVirtualKeyStates.Down)
                           || control.HasFlag(CoreVirtualKeyStates.Down);
            if (modified)
            {
                return;
            }

            e.Handled = true;
            Submit();
        };

        return input;
    }

    private Button BuildPrimary()
    {
        var button = Ui.Solid("Send", "\uE725");
        button.Padding = new Thickness(Tk.Sp.S12, Tk.Sp.S6, Tk.Sp.S12, Tk.Sp.S8);
        ToolTipService.SetToolTip(button, "Send  ·  Enter");
        button.Click += (_, _) =>
        {
            if (_running)
            {
                StopRequested?.Invoke();
            }
            else
            {
                Submit();
            }
        };
        return button;
    }

    /// <summary>
    /// The context strip. This is the composer's real content: what the next turn will use.
    /// Left side is environment, right side is the single primary action.
    /// </summary>
    private FrameworkElement BuildContextStrip()
    {
        var attach = Ui.IconButton("\uE723", "Attach files  ·  Ctrl+O", 30);
        attach.Click += (_, _) => PickFiles();

        var agent = BuildAgentChip();

        var scope = Ui.Chip("2 roots", Tk.FillSand, Tk.TextSlate, Tk.Line);
        ToolTipService.SetToolTip(scope,
            "Tools may read and write inside:\n  Services/Cyrene-Navigator\n  ~/.cyrene/harness/cache");

        var left = Ui.HStack(Tk.Sp.S8, attach, agent, _model, scope, _runningLabel);

        var right = Ui.HStack(Tk.Sp.S8,
            Typo.Label("enter to send", Tk.Wash(Tk.Raw.Muted, 0.7)),
            _primary);

        var row = new Grid
        {
            Padding = new Thickness(Tk.Sp.S8, Tk.Sp.S6, Tk.Sp.S8, Tk.Sp.S8),
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.Children.Add(left.At(0));
        row.Children.Add(right.At(1));
        return row;
    }

    private FrameworkElement BuildAgentChip()
    {
        var label = new TextBlock
        {
            Text = "Navigator Agent",
            FontFamily = Tk.Ty.Display,
            FontSize = 12.5,
            FontWeight = FontWeights.SemiBold,
            CharacterSpacing = 10,
            Foreground = Tk.TextInk,
            VerticalAlignment = VerticalAlignment.Center,
        };

        var content = Ui.HStack(Tk.Sp.S8,
            Ui.Diamond(Tk.Coral, Tk.FillPaper, 6),
            label,
            Typo.Glyph("\uE70D", 9, Tk.Wash(Tk.Raw.Muted, 0.8)));

        var button = new Button
        {
            Content = content,
            Background = Tk.FillTransparent,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Hair,
            CornerRadius = Tk.Rad.Xs,
            Padding = new Thickness(Tk.Sp.S10, Tk.Sp.S4, Tk.Sp.S8, Tk.Sp.S6),
        };

        var flyout = new MenuFlyout();
        foreach (var (name, note) in new[]
                 {
                     ("Navigator Agent", "Full tool access inside the project"),
                     ("Read-only Agent", "No writes, no shell"),
                     ("Docs Agent", "Prose and artifacts only"),
                     ("Migration Agent", "Database and deployment tasks"),
                 })
        {
            var item = new MenuFlyoutItem { Text = name };
            var selectedName = name;
            item.Click += (_, _) => label.Text = selectedName;
            ToolTipService.SetToolTip(item, note);
            flyout.Items.Add(item);
        }

        flyout.Items.Add(new MenuFlyoutSeparator());
        flyout.Items.Add(new MenuFlyoutItem { Text = "Configure agents…", Icon = new FontIcon { Glyph = "\uE713" } });
        button.Flyout = flyout;

        ToolTipService.SetToolTip(button, "Agent for this session");
        return button;
    }

    private async void PickFiles()
    {
        try
        {
            var picker = AppHost.OpenPicker();
            var file = await picker.PickSingleFileAsync();
            if (file is not null)
            {
                _input.Text = _input.Text.Length == 0
                    ? $"Look at {file.Name} and tell me what changed."
                    : _input.Text + "\n" + file.Path;
                _input.Focus(FocusState.Programmatic);
                _input.SelectionStart = _input.Text.Length;
            }
        }
        catch (Exception)
        {
            // The picker needs a live window handle; nothing to report if it has gone.
        }
    }

    private void Submit()
    {
        var text = _input.Text.Trim();
        if (text.Length == 0)
        {
            return;
        }

        _input.Text = string.Empty;
        Submitted?.Invoke(text);
    }

    /// <summary>Focuses the input, for the window-level Ctrl+L accelerator.</summary>
    public void FocusInput() => _input.Focus(FocusState.Programmatic);

    /// <summary>Opens the model picker, for Ctrl+M.</summary>
    public void OpenModelPicker() => _model.Open();

    /// <summary>
    /// Switches between Send and Stop. While running, the trace arrives at the composer's top
    /// edge as a gradient hairline — the same line that runs down the transcript.
    /// </summary>
    public void SetRunning(bool running)
    {
        _running = running;
        _liveEdge.Opacity = running ? 1 : 0;
        _runningLabel.Visibility = running ? Visibility.Visible : Visibility.Collapsed;

        if (running)
        {
            _primary.Content = Ui.HStack(Tk.Sp.S8,
                Typo.Glyph("\uE71A", 13, Tk.TextOnInk),
                new TextBlock
                {
                    Text = "Stop",
                    FontFamily = Tk.Ty.Display,
                    FontSize = 13,
                    FontWeight = FontWeights.SemiBold,
                    CharacterSpacing = 20,
                });
            _primary.Background = Tk.Danger;
            ToolTipService.SetToolTip(_primary, "Stop the run  ·  Esc");
        }
        else
        {
            _primary.Content = Ui.HStack(Tk.Sp.S8,
                Typo.Glyph("\uE725", 13, Tk.TextOnInk),
                new TextBlock
                {
                    Text = "Send",
                    FontFamily = Tk.Ty.Display,
                    FontSize = 13,
                    FontWeight = FontWeights.SemiBold,
                    CharacterSpacing = 20,
                });
            _primary.Background = Tk.FillInk;
            ToolTipService.SetToolTip(_primary, "Send  ·  Enter");
        }
    }
}
