// Views/ActivityPage.cs
//
// Activity destination / 活动页。
//
// The long-running-work view. A model that works for ten minutes needs somewhere you can watch
// it without sitting inside the transcript, and somewhere the runs that are *waiting on you*
// cannot hide.
//
// Ordering is by urgency, not by time: anything blocked on a human comes first, then running,
// then failed, then finished. That is the only ordering that makes the page actionable.
//
// 排序按"是否需要你处理"，不是按时间 —— 等你审批的永远在最上面。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Controls;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Core.Api;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Views;

public sealed class ActivityPage : Grid
{
    private readonly IAgentState _agent;
    private readonly INavigatorUiData _data;
    private readonly List<AgentRun> _runs = new();
    private readonly StackPanel _listPanel;
    private readonly Border _detailHost;
    private readonly Dictionary<string, Button> _rows = new();
    private readonly Dictionary<string, Border> _indicators = new();

    private AgentRun _selected;
    private AgentProgress? _detailProgress;
    private DispatcherTimer? _clock;

    public ActivityPage(IAgentState agent, INavigatorUiData data)
    {
        _agent = agent;
        _data = data;
        Background = Tk.FillPaper;

        _runs.Add(agent.Run);
        _runs.AddRange(agent.BackgroundRuns());
        SortByUrgency();
        _selected = _runs[0];

        RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        RowDefinitions.Add(new RowDefinition { Height = Ui.Star() });
        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        var header = BuildHeader();
        Grid.SetColumnSpan(header, 2);
        Children.Add(header.At(0, 0));

        _listPanel = new StackPanel { Orientation = Orientation.Vertical };
        var listHost = new Border
        {
            Width = 360,
            Background = Tk.FillSand,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Right,
            Child = new ScrollViewer
            {
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollMode = ScrollMode.Disabled,
                Content = _listPanel,
            },
        };
        Children.Add(listHost.At(0, 1));

        _detailHost = new Border { Background = Tk.FillPaper };
        Children.Add(_detailHost.At(1, 1));

        BuildList();
        ShowDetail(_selected);

        Loaded += (_, _) => StartClock();
        Unloaded += (_, _) => _clock?.Stop();
    }

    // -----------------------------------------------------------------------------------------

    private FrameworkElement BuildHeader()
    {
        var waiting = 0;
        var running = 0;
        foreach (var run in _runs)
        {
            if (run.State == RunState.AwaitingApproval)
            {
                waiting++;
            }

            if (run.State == RunState.Running)
            {
                running++;
            }
        }

        var summary = waiting > 0
            ? $"{waiting} waiting on you  ·  {running} running  ·  {_runs.Count} total today"
            : $"{running} running  ·  {_runs.Count} total today";

        var titles = Ui.VStack(4,
            Typo.Display("Activity", 24),
            Typo.Meta(summary, waiting > 0 ? Tk.Coral : Tk.TextMuted));

        var actions = Ui.HStack(Tk.Sp.S4,
            Ui.Ghost("Start run", "\uE72C"),
            Ui.Ghost("Run history", "\uE81C"));
        actions.HorizontalAlignment = HorizontalAlignment.Right;
        ((Button)actions.Children[0]).Click += (_, _) =>
        {
            try
            {
                _agent.Restart();
            }
            catch (NavigatorApiError error)
            {
                ShowActionError(error);
                return;
            }

            BuildList();
            ShowDetail(_agent.Run);
        };

        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.Children.Add(titles.At(0));
        row.Children.Add(actions.At(1));

        var stack = new StackPanel { Orientation = Orientation.Vertical };
        stack.Children.Add(new Border { Padding = new Thickness(0, Tk.Sp.S24, 0, Tk.Sp.S16), Child = row });
        stack.Children.Add(Ui.HorizonRule(0.42));

        return new Border
        {
            Padding = new Thickness(Tk.Sp.S32, 0, Tk.Sp.S32, 0),
            Child = stack,
        };
    }

    /// <summary>Blocked first, then running, then failed, then done.</summary>
    private void SortByUrgency()
    {
        _runs.Sort((a, b) => Rank(a).CompareTo(Rank(b)));

        static int Rank(AgentRun run) => run.State switch
        {
            RunState.AwaitingApproval => 0,
            RunState.Running => 1,
            RunState.Failed => 2,
            RunState.Cancelled => 3,
            _ => 4,
        };
    }

    private void BuildList()
    {
        _listPanel.Children.Clear();
        _rows.Clear();
        _indicators.Clear();

        SortByUrgency();
        foreach (var run in _runs)
        {
            _listPanel.Children.Add(BuildListRow(run));
        }
    }

    /// <summary>
    /// A run row: state diamond, goal, agent + model, elapsed, and a hairline progress meter.
    /// The meter is the only quantity here because "how far along" is the only number you can
    /// act on from a list.
    /// </summary>
    private FrameworkElement BuildListRow(AgentRun run)
    {
        var done = 0;
        foreach (var step in run.Steps)
        {
            if (step.State is StepState.Done or StepState.Skipped)
            {
                done++;
            }
        }

        var fraction = run.Steps.Count == 0 ? 0 : done / (double)run.Steps.Count;

        var goal = new TextBlock
        {
            Text = run.Goal,
            FontFamily = Tk.Ty.Text,
            FontSize = 13.5,
            Foreground = Tk.TextInk,
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextWrapping = TextWrapping.NoWrap,
        };

        var identity = Ui.HStack(Tk.Sp.S8,
            Typo.Label(run.AgentName, Tk.Wash(Tk.Raw.Slate, 0.9)),
            Typo.Label("·", Tk.Wash(Tk.Raw.Muted, 0.4)),
            Typo.Label(run.ModelLabel, Tk.Orchid));

        var status = Ui.HStack(Tk.Sp.S8,
            Typo.Label(StateLabel(run.State), StateBrush(run.State)),
            Typo.Mono(Ui.Duration(run.Elapsed), Tk.Wash(Tk.Raw.Muted, 0.8), 11));

        var meter = Ui.Meter(fraction, double.NaN, 2, run.State == RunState.Failed ? Tk.Danger : Tk.Horizon);
        meter.Margin = new Thickness(0, Tk.Sp.S6, 0, 0);

        var texts = Ui.VStack(3, goal, identity, status, meter);

        var head = new Grid { ColumnSpacing = Tk.Sp.S10 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(14) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        var mark = StateMark(run.State);
        mark.VerticalAlignment = VerticalAlignment.Top;
        mark.Margin = new Thickness(0, 4, 0, 0);
        head.Children.Add(mark.At(0));
        head.Children.Add(texts.At(1));

        var surface = new Button
        {
            Content = head,
            Background = run.Id == _selected.Id ? Tk.FillSelected : Tk.FillTransparent,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
            CornerRadius = Tk.Rad.None,
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
        };
        surface.PointerEntered += (_, _) =>
        {
            if (run.Id != _selected.Id) surface.Background = Tk.FillHover;
        };
        surface.PointerExited += (_, _) =>
        {
            surface.Background = run.Id == _selected.Id ? Tk.FillSelected : Tk.FillTransparent;
        };
        surface.Click += (_, _) => ShowDetail(run);

        var indicator = new Border
        {
            Width = Tk.Ln.Indicator,
            Background = Tk.TraceLive,
            HorizontalAlignment = HorizontalAlignment.Left,
            VerticalAlignment = VerticalAlignment.Stretch,
            Margin = new Thickness(0, Tk.Sp.S8, 0, Tk.Sp.S8),
            CornerRadius = new CornerRadius(1),
            Opacity = run.Id == _selected.Id ? 1 : 0,
            IsHitTestVisible = false,
        };

        _rows[run.Id] = surface;
        _indicators[run.Id] = indicator;

        var host = new Grid();
        host.Children.Add(surface);
        host.Children.Add(indicator);
        return host;
    }

    private void ShowDetail(AgentRun run)
    {
        _selected = run;

        foreach (var pair in _indicators)
        {
            pair.Value.Opacity = pair.Key == run.Id ? 1 : 0;
        }

        foreach (var pair in _rows)
        {
            pair.Value.Background = pair.Key == run.Id ? Tk.FillSelected : Tk.FillTransparent;
        }

        var stack = new StackPanel { Orientation = Orientation.Vertical, Spacing = Tk.Sp.S20, MaxWidth = 820 };
        stack.HorizontalAlignment = HorizontalAlignment.Left;

        stack.Children.Add(BuildDetailHead(run));

        if (run.State == RunState.AwaitingApproval)
        {
            var approval = _agent.PendingApproval(run.Id);
            if (approval is not null)
            {
                var card = new ApprovalCard(approval);
                card.Decided += decision =>
                {
                    try
                    {
                        _agent.Decide(run.Id, decision);
                    }
                    catch (NavigatorApiError error)
                    {
                        ShowActionError(error);
                        return;
                    }

                    BuildList();
                    ShowDetail(run);
                };
                stack.Children.Add(card);
            }
        }

        _detailProgress = new AgentProgress(run, _data, showChrome: false);
        stack.Children.Add(Ui.VStack(Tk.Sp.S8,
            Typo.Eyebrow("trace"),
            _detailProgress));

        stack.Children.Add(Ui.Divider());
        stack.Children.Add(Ui.VStack(Tk.Sp.S10,
            Typo.Eyebrow("this run"),
            UsageIndicator.Inline(run.Usage)));

        _detailHost.Child = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Disabled,
            Padding = new Thickness(Tk.Sp.S32, Tk.Sp.S24, Tk.Sp.S32, Tk.Sp.S32),
            Content = stack,
        };
    }

    private FrameworkElement BuildDetailHead(AgentRun run)
    {
        var head = Ui.VStack(Tk.Sp.S8,
            Ui.HStack(Tk.Sp.S10,
                StateMark(run.State),
                Typo.Eyebrow(StateLabel(run.State), StateBrush(run.State)),
                Typo.Mono(Ui.Duration(run.Elapsed), Tk.TextMuted, 11.5),
                Typo.Label("·", Tk.Wash(Tk.Raw.Muted, 0.4)),
                Typo.Mono(run.Id, Tk.Wash(Tk.Raw.Muted, 0.8), 11.5)),
            Typo.Title(run.Goal, 19),
            Ui.HStack(Tk.Sp.S8,
                Typo.Label(run.AgentName, Tk.Wash(Tk.Raw.Slate, 0.9)),
                Typo.Label("·", Tk.Wash(Tk.Raw.Muted, 0.4)),
                Typo.Label(run.ModelLabel, Tk.Orchid)));

        var actions = Ui.HStack(Tk.Sp.S8);
        if (run.State == RunState.Running)
        {
            var stop = Ui.Outline("Stop run", "\uE71A");
            stop.Foreground = Tk.Danger;
            stop.Click += (_, _) =>
            {
                if (run.Id != _agent.Run.Id)
                {
                    ShowActionError(NavigatorApiError.NotConnected(
                        "Cancelling another run",
                        "only the current session's run can be controlled from this client."));
                    return;
                }

                try
                {
                    _agent.Stop();
                }
                catch (NavigatorApiError error)
                {
                    ShowActionError(error);
                    return;
                }

                BuildList();
                ShowDetail(run);
            };
            actions.Children.Add(stop);
        }

        if (run.State == RunState.Failed)
        {
            actions.Children.Add(Ui.Solid("Retry from failed step", "\uE72C"));
        }

        actions.Children.Add(Ui.Ghost("Open session", "\uE8A7"));
        head.Children.Add(actions);

        return run.State == RunState.AwaitingApproval || run.State == RunState.Running
            ? Ui.GradientCard(head, new Thickness(Tk.Sp.S20, Tk.Sp.S16, Tk.Sp.S20, Tk.Sp.S16))
            : Ui.Card(head, new Thickness(Tk.Sp.S20, Tk.Sp.S16, Tk.Sp.S20, Tk.Sp.S16));
    }

    /// <summary>
    /// Surfaces a typed port failure so approval, cancel, and control actions stay observable
    /// instead of silently changing local state.
    /// </summary>
    private async void ShowActionError(NavigatorApiError error)
    {
        var body = Ui.VStack(Tk.Sp.S8,
            Typo.Body(error.Message),
            Typo.Meta(error.Code, Tk.TextMuted));
        var dialog = AppHost.Dialog("Action not connected", body, "OK", null, "Close");
        if (dialog is null)
        {
            return;
        }

        await dialog.ShowAsync();
    }

    private void StartClock()
    {
        _clock = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
        _clock.Tick += (_, _) =>
        {
            if (!_agent.Tick(TimeSpan.FromMilliseconds(120)))
            {
                return;
            }

            BuildList();

            // Refresh the trace in place rather than rebuilding the detail pane, which would
            // throw away the reader's scroll position on every step transition.
            if (_selected.Id == _agent.Run.Id)
            {
                _detailProgress?.Refresh();
            }
        };
        _clock.Start();
    }

    // -----------------------------------------------------------------------------------------

    private static string StateLabel(RunState state) => state switch
    {
        RunState.Running => "running",
        RunState.AwaitingApproval => "waiting on you",
        RunState.Failed => "stopped",
        RunState.Cancelled => "cancelled",
        RunState.Done => "finished",
        _ => "queued",
    };

    private static Brush StateBrush(RunState state) => state switch
    {
        RunState.Running => Tk.Coral,
        RunState.AwaitingApproval => Tk.Coral,
        RunState.Failed => Tk.Danger,
        RunState.Done => Tk.Wash(Tk.Raw.Slate, 0.9),
        _ => Tk.TextMuted,
    };

    private static FrameworkElement StateMark(RunState state)
    {
        switch (state)
        {
            case RunState.Running:
            {
                var mark = Ui.SolidDiamond(8);
                Ui.Breathe(mark, 0.5, 1);
                return mark;
            }

            case RunState.AwaitingApproval:
                return Ui.Diamond(Tk.Coral, Tk.Wash(Tk.Raw.Coral, 0.16), 8);

            case RunState.Failed:
                return Ui.Diamond(Tk.Danger, Tk.Wash(Tk.Raw.Danger, 0.14), 7);

            case RunState.Done:
                return Ui.Diamond(Tk.Orchid, Tk.FillPaper, 7);

            default:
                return Ui.Diamond(Tk.LineStrong, Tk.FillPaper, 6);
        }
    }
}
