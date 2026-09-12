// Controls/AgentProgress.cs
//
// Agent run trace / Agent 运行轨迹。
//
// The problem this solves: a model working for ten minutes produces hundreds of events, and the
// default answer — print them all — turns the screen into a terminal log that nobody reads.
//
// The design instead answers exactly one question at a glance: *what is happening now*.
//
//   · Finished phases collapse to a single muted line. They keep their place on the trace but
//     lose almost all their ink.
//   · The current phase is the only one with children visible, the only one at full contrast,
//     and the only one carrying the brand gradient on its trace segment.
//   · Phases not yet reached are dashed hairlines with no detail at all.
//   · More than three finished phases fold behind one line you can open.
//
// The trace here is the same control the conversation uses, at a smaller scale — so "the path
// this run took" and "the path this session took" read as one idea.
//
// 关键：已完成的信息自动降权，当前步骤最明显，细节随时可展开。不是把日志全部铺开。

using System;
using System.Collections.Generic;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Cyrene.Navigator.Windows.Controls;

public sealed class AgentProgress : Grid
{
    /// <summary>Finished phases shown before the rest fold away.</summary>
    private const int VisibleSettledPhases = 3;

    private readonly AgentRun _run;
    private readonly INavigatorUiData _data;
    private readonly bool _showChrome;
    private readonly StackPanel _steps;
    private readonly StackPanel _root;
    private bool _showAllSettled;

    /// <summary>Raised when the user asks to stop the run.</summary>
    public event Action? StopRequested;

    /// <param name="run">Run to visualise.</param>
    /// <param name="showChrome">
    /// True for the inline conversation card (header, goal, footer). False when the caller
    /// already provides that framing, as the Activity page does.
    /// </param>
    public AgentProgress(AgentRun run, INavigatorUiData data, bool showChrome = true)
    {
        _run = run;
        _data = data;
        _showChrome = showChrome;
        _steps = new StackPanel { Orientation = Orientation.Vertical };
        _root = new StackPanel { Orientation = Orientation.Vertical };

        Rebuild();

        if (showChrome)
        {
            Children.Add(new Border
            {
                Background = Tk.FillPaper,
                BorderBrush = Tk.Line,
                BorderThickness = Tk.Ln.Hair,
                CornerRadius = Tk.Rad.Lg,
                MaxWidth = MessageView.ProseWidth,
                HorizontalAlignment = HorizontalAlignment.Left,
                Child = _root,
            });
        }
        else
        {
            Children.Add(_root);
        }
    }

    /// <summary>Redraws after the run state advanced. Called from the caller's timer tick.</summary>
    public void Refresh() => Rebuild();

    // -----------------------------------------------------------------------------------------

    private void Rebuild()
    {
        _root.Children.Clear();

        if (_showChrome)
        {
            _root.Children.Add(BuildHeader());
        }

        BuildSteps();
        _root.Children.Add(_steps);

        if (_showChrome)
        {
            _root.Children.Add(BuildFooter());
        }
    }

    private FrameworkElement BuildHeader()
    {
        var top = new Grid { ColumnSpacing = Tk.Sp.S10 };
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        top.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        top.Children.Add(BuildStateBadge().At(0));

        var identity = Ui.HStack(Tk.Sp.S8,
            Typo.Label(_run.AgentName, Tk.Wash(Tk.Raw.Slate, 0.9)),
            Typo.Label("·", Tk.Wash(Tk.Raw.Muted, 0.5)),
            Typo.Label(_run.ModelLabel, Tk.Orchid));
        identity.HorizontalAlignment = HorizontalAlignment.Right;
        top.Children.Add(identity.At(2));

        var goal = Typo.Body(_run.Goal, Tk.TextInk);
        goal.FontSize = 14.5;
        goal.Margin = new Thickness(0, Tk.Sp.S6, 0, 0);
        goal.MaxWidth = 600;

        var head = Ui.VStack(0, top, goal);
        return new Border
        {
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S16, Tk.Sp.S12),
            Child = head,
        };
    }

    private FrameworkElement BuildStateBadge()
    {
        switch (_run.State)
        {
            case RunState.Running:
            {
                var mark = Ui.SolidDiamond(8);
                Ui.Breathe(mark, 0.55, 1);
                var label = Typo.Eyebrow("running", Tk.Coral);
                return Ui.HStack(8, mark, label, Typo.Mono(Ui.Duration(_run.Elapsed), Tk.TextMuted, 11.5));
            }

            case RunState.AwaitingApproval:
                return Ui.HStack(8,
                    Ui.SolidDiamond(8),
                    Typo.Eyebrow("waiting on you", Tk.Coral),
                    Typo.Mono(Ui.Duration(_run.Elapsed), Tk.TextMuted, 11.5));

            case RunState.Failed:
                return Ui.HStack(8,
                    Ui.Diamond(Tk.Danger, Tk.Danger, 7),
                    Typo.Eyebrow("stopped", Tk.Danger),
                    Typo.Mono(Ui.Duration(_run.Elapsed), Tk.Wash(Tk.Raw.Danger, 0.8), 11.5));

            case RunState.Cancelled:
                return Ui.HStack(8,
                    Ui.Diamond(Tk.LineStrong, Tk.FillPaper, 7),
                    Typo.Eyebrow("cancelled", Tk.TextMuted));

            default:
                return Ui.HStack(8,
                    Ui.Diamond(Tk.Orchid, Tk.FillPaper, 7),
                    Typo.Eyebrow("finished", Tk.Wash(Tk.Raw.Slate, 0.9)),
                    Typo.Mono(Ui.Duration(_run.Elapsed), Tk.TextMuted, 11.5));
        }
    }

    private void BuildSteps()
    {
        _steps.Children.Clear();

        var currentIndex = ActiveIndex();
        var settledBefore = new List<int>();
        for (var i = 0; i < _run.Steps.Count; i++)
        {
            if (i < currentIndex)
            {
                settledBefore.Add(i);
            }
        }

        var hidden = 0;
        var firstVisibleSettled = 0;
        if (!_showAllSettled && settledBefore.Count > VisibleSettledPhases)
        {
            hidden = settledBefore.Count - VisibleSettledPhases;
            firstVisibleSettled = hidden;
        }

        // How many rows the live gradient has to cover, so the gradient can be split across them.
        var liveRows = 1;
        if (currentIndex >= 0 && currentIndex < _run.Steps.Count)
        {
            liveRows = 1 + _run.Steps[currentIndex].Children.Count;
        }

        var liveRow = 0;

        for (var i = 0; i < _run.Steps.Count; i++)
        {
            if (hidden > 0 && i < firstVisibleSettled)
            {
                continue;
            }

            if (hidden > 0 && i == firstVisibleSettled)
            {
                _steps.Children.Add(BuildFoldRow(hidden));
            }

            var step = _run.Steps[i];
            var isCurrent = i == currentIndex;

            if (isCurrent)
            {
                var (t0, t1) = TraceGutter.Segment(liveRow++, liveRows);
                _steps.Children.Add(BuildPhaseRow(step, TraceRole.Live, t0, t1, emphasis: true, isLast: false));

                foreach (var child in step.Children)
                {
                    var (c0, c1) = TraceGutter.Segment(liveRow++, liveRows);
                    _steps.Children.Add(BuildChildRow(child, c0, c1));
                }
            }
            else if (i < currentIndex)
            {
                _steps.Children.Add(BuildPhaseRow(step, TraceRole.Settled, 0, 0, emphasis: false, isLast: false));
            }
            else
            {
                var isLast = i == _run.Steps.Count - 1;
                _steps.Children.Add(BuildPhaseRow(step, TraceRole.Pending, 0, 0, emphasis: false, isLast: isLast));
            }
        }
    }

    private int ActiveIndex()
    {
        for (var i = 0; i < _run.Steps.Count; i++)
        {
            if (_run.Steps[i].State is StepState.Running or StepState.Failed)
            {
                return i;
            }
        }

        return _run.Steps.Count - 1;
    }

    /// <summary>
    /// One phase row: trace slice, node, title, timing. Emphasis is the whole point — the current
    /// phase is a different type size and a different ink weight from everything else.
    /// </summary>
    private FrameworkElement BuildPhaseRow(AgentStep step, TraceRole role, double t0, double t1, bool emphasis, bool isLast)
    {
        var node = step.State switch
        {
            StepState.Running => NodeKind.Active,
            StepState.Failed => NodeKind.Failed,
            StepState.Done => NodeKind.Done,
            StepState.Skipped => NodeKind.Anchor,
            _ => NodeKind.None,
        };

        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(30) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        row.Children.Add(new TraceGutter(
            role,
            node,
            t0,
            t1,
            nodeOffset: emphasis ? 13 : 11,
            width: 30,
            stopAtNode: isLast && node == NodeKind.None).At(0));

        var titleBrush = step.State switch
        {
            StepState.Failed => Tk.Danger,
            StepState.Pending => Tk.Wash(Tk.Raw.Muted, 0.62),
            StepState.Skipped => Tk.Wash(Tk.Raw.Muted, 0.5),
            _ => emphasis ? Tk.TextInk : Tk.Wash(Tk.Raw.Slate, 0.62),
        };

        var title = new TextBlock
        {
            Text = step.Title,
            FontFamily = emphasis ? Tk.Ty.Display : Tk.Ty.Text,
            FontSize = emphasis ? 14.5 : 13,
            FontWeight = emphasis ? FontWeights.SemiBold : FontWeights.Normal,
            Foreground = titleBrush,
            TextTrimming = TextTrimming.CharacterEllipsis,
            TextWrapping = TextWrapping.NoWrap,
        };

        var texts = Ui.VStack(2, title);

        // Only the phase you are looking at earns a detail line.
        if (emphasis && !string.IsNullOrWhiteSpace(step.Detail))
        {
            var detail = Typo.Meta(step.Detail, Tk.TextSlate);
            detail.TextWrapping = TextWrapping.Wrap;
            detail.MaxWidth = 460;
            texts.Children.Add(detail);
        }

        texts.Margin = new Thickness(0, emphasis ? Tk.Sp.S4 : Tk.Sp.S2, 0, emphasis ? Tk.Sp.S4 : Tk.Sp.S2);
        row.Children.Add(texts.At(1));

        if (step.State is StepState.Done or StepState.Running && step.Elapsed > TimeSpan.Zero)
        {
            var timing = Typo.Mono(
                Ui.Duration(step.Elapsed),
                Tk.Wash(Tk.Raw.Muted, emphasis ? 0.9 : 0.55),
                11);
            timing.VerticalAlignment = VerticalAlignment.Top;
            timing.Margin = new Thickness(Tk.Sp.S12, emphasis ? 6 : 4, Tk.Sp.S16, 0);
            row.Children.Add(timing.At(2));
        }

        return row;
    }

    /// <summary>
    /// A tool call inside the current phase. Rendered in the mono face because these are literal
    /// commands and paths — and indented off a short elbow so the branching reads structurally.
    /// </summary>
    private FrameworkElement BuildChildRow(AgentStep child, double t0, double t1)
    {
        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(30) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        row.Children.Add(new TraceGutter(
            TraceRole.Live,
            NodeKind.None,
            t0,
            t1,
            nodeOffset: 10,
            elbow: true,
            width: 30).At(0));

        var running = child.State == StepState.Running;
        var brush = child.State switch
        {
            StepState.Failed => Tk.Danger,
            StepState.Pending => Tk.Wash(Tk.Raw.Muted, 0.55),
            StepState.Skipped => Tk.Wash(Tk.Raw.Muted, 0.45),
            _ => running ? Tk.Wash(Tk.Raw.Ink, 0.9) : Tk.Wash(Tk.Raw.Slate, 0.7),
        };

        var marker = Ui.HStack(Tk.Sp.S8);
        if (running)
        {
            var pip = Ui.SolidDiamond(5);
            Ui.Breathe(pip, 0.4, 1);
            marker.Children.Add(pip);
        }
        else if (child.State == StepState.Done)
        {
            marker.Children.Add(Ui.Diamond(Tk.Wash(Tk.Raw.Muted, 0.55), Tk.FillPaper, 4));
        }
        else
        {
            marker.Children.Add(new Border { Width = 4, Height = 1, Background = Tk.LineFaint });
        }

        var title = Typo.Mono(child.Title, brush, 12);
        title.TextTrimming = TextTrimming.CharacterEllipsis;
        marker.Children.Add(title);

        var texts = Ui.VStack(1, marker);

        if (running && !string.IsNullOrWhiteSpace(child.Detail))
        {
            var detail = Typo.Meta(child.Detail, Tk.TextMuted);
            detail.Margin = new Thickness(Tk.Sp.S12, 0, 0, 0);
            texts.Children.Add(detail);
        }

        texts.Margin = new Thickness(Tk.Sp.S4, 3, 0, 3);
        row.Children.Add(texts.At(1));

        if (child.Tool is not null)
        {
            var kind = Typo.Label(_data.ToolLabel(child.Tool.Value), Tk.Wash(Tk.Raw.Muted, running ? 0.8 : 0.45));
            kind.VerticalAlignment = VerticalAlignment.Top;
            kind.Margin = new Thickness(Tk.Sp.S12, 5, Tk.Sp.S16, 0);
            row.Children.Add(kind.At(2));
        }

        return row;
    }

    /// <summary>The fold: one line standing in for everything already finished.</summary>
    private FrameworkElement BuildFoldRow(int hidden)
    {
        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(30) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        row.Children.Add(new TraceGutter(TraceRole.Settled, NodeKind.None, width: 30).At(0));

        var button = Ui.Ghost($"{hidden} earlier {(hidden == 1 ? "phase" : "phases")}", "\uE70D");
        button.Margin = new Thickness(-Tk.Sp.S8, 0, 0, 0);
        button.Click += (_, _) =>
        {
            _showAllSettled = true;
            BuildSteps();
        };
        row.Children.Add(button.At(1));
        return row;
    }

    private FrameworkElement BuildFooter()
    {
        var row = new Grid
        {
            Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S10, Tk.Sp.S12, Tk.Sp.S10),
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Top,
        };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        row.Children.Add(UsageIndicator.Inline(_run.Usage).At(0));

        var actions = Ui.HStack(Tk.Sp.S4);
        if (_run.State == RunState.Running)
        {
            var stop = Ui.Ghost("Stop", "\uE71A");
            stop.Foreground = Tk.Danger;
            stop.Click += (_, _) => StopRequested?.Invoke();
            actions.Children.Add(stop);
        }

        actions.Children.Add(Ui.Ghost("Full trace", "\uE8A7"));
        actions.HorizontalAlignment = HorizontalAlignment.Right;
        row.Children.Add(actions.At(1));

        return row;
    }
}
