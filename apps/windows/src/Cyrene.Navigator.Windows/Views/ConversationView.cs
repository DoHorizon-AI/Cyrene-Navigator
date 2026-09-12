// Views/ConversationView.cs
//
// The conversation / 主对话界面。
//
// This is the screen the whole design is judged on, so the decisions here are the ones that
// matter most:
//
//   Reading column. Header, transcript and composer share one 1000px measure, centred. Long
//   prose gets a comfortable line length instead of stretching to a 27" monitor, and because
//   all three layers share the measure, the page reads as one composed sheet rather than three
//   stacked panels.
//
//   The trace. Every row hangs off a hairline in a 40px left gutter. Through settled history it
//   is neutral; one row before the live region it rises into brand colour; from there down it is
//   a single continuous gradient split across the live rows, and it arrives at the composer's
//   top edge. You can see where "now" is from across the room without reading a word.
//
//   Virtualization. The transcript is a VirtualList over ~130 heterogeneous rows. Streaming
//   touches one row, and inside that row only the markdown blocks that changed.
//
// 三层共享同一个阅读宽度；轨迹线从历史一路亮到输入区。滚动、流式、展开都不会重排整页。

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using Cyrene.Navigator.Windows.Controls;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Core.Api;
using Cyrene.Navigator.Windows.Design;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Storage;

namespace Cyrene.Navigator.Windows.Views;

public sealed class ConversationView : Grid
{
    /// <summary>Shared measure for header, transcript and composer.</summary>
    public const double ReadingWidth = 1000;

    private readonly IConversationService _service;
    private readonly IAgentState _agent;
    private readonly INavigatorUiData _data;

    /// <summary>
    /// Observable so that appending a turn is an incremental list update rather than a rebuild.
    /// Re-binding the whole source on every new message is the other classic way chat clients
    /// end up re-laying-out an entire transcript.
    /// </summary>
    private readonly ObservableCollection<TimelineItem> _items;
    private readonly Dictionary<string, (double T0, double T1)> _segments = new();
    private readonly VirtualList _timeline;
    private readonly Composer _composer;
    private readonly TextBlock _title;
    private readonly TextBlock _subtitle;
    private readonly Border _runPanelHost;
    private readonly StackPanel _runPanelContent;
    private readonly Grid _headerUsage;

    private StreamingScript _stream;
    private TurnItem _streamingTurn;
    private MessageView? _streamingView;
    private AgentProgress? _inlineRun;
    private AgentProgress? _panelProgress;
    private DispatcherTimer? _clock;
    private bool _runPanelOpen;
    private bool _opened;

    public ConversationView(IConversationService service, IAgentState agent, INavigatorUiData data)
    {
        _service = service;
        _agent = agent;
        _data = data;
        _items = new ObservableCollection<TimelineItem>(service.Timeline());
        _stream = service.StreamingTail();
        _streamingTurn = FindStreamingTurn();

        AssignSegments();

        RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        RowDefinitions.Add(new RowDefinition { Height = Ui.Star() });
        RowDefinitions.Add(new RowDefinition { Height = Ui.Auto });
        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });

        Background = Tk.FillPaper;

        _title = Typo.Title("No session open", 17);
        _subtitle = Typo.Meta(service.ConnectionDetail, Tk.TextMuted);
        _headerUsage = new Grid();

        var header = BuildHeader();
        Grid.SetColumnSpan(header, 2);
        Children.Add(header.At(0, 0));

        _timeline = new VirtualList(BuildTimelineRow)
        {
            ItemsSource = _items,
            Padding = new Thickness(0, Tk.Sp.S8, 0, Tk.Sp.S32),
        };
        Children.Add(_timeline.At(0, 1));

        _runPanelContent = new StackPanel { Orientation = Orientation.Vertical, Spacing = Tk.Sp.S16 };
        _runPanelHost = BuildRunPanel();
        _runPanelHost.Visibility = Visibility.Collapsed;
        Children.Add(_runPanelHost.At(1, 1));

        _composer = new Composer(_data.DefaultModel, _data);
        _composer.Submitted += OnSubmitted;
        _composer.StopRequested += OnStopRequested;
        _composer.ModelChanged += OnModelChanged;
        var composerHost = BuildComposerHost();
        Grid.SetColumnSpan(composerHost, 2);
        Children.Add(composerHost.At(0, 2));

        Loaded += OnLoaded;
        Unloaded += (_, _) => _clock?.Stop();
    }

    public Composer Composer => _composer;

    /// <summary>Row count, for capture mode's index arithmetic.</summary>
    public int RowCount => _items.Count;

    /// <summary>Scrolls a specific row to the top. Used by capture mode and by deep links.</summary>
    public void RevealIndex(int index)
    {
        if (_items.Count == 0)
        {
            return;
        }

        var clamped = Math.Max(0, Math.Min(_items.Count - 1, index));
        _timeline.ScrollIntoView(_items[clamped], leading: true);
    }

    /// <summary>
    /// Opens another session on the service and rebuilds the transcript from that session's
    /// committed events. In preview mode the service keeps its single fixture timeline.
    /// </summary>
    public void SetSession(SessionSummary session)
    {
        _service.OpenSession(session.Id);
        _items.Clear();
        foreach (var item in _service.Timeline())
        {
            _items.Add(item);
        }

        _stream = _service.StreamingTail();
        _streamingView = null;
        _streamingTurn = FindStreamingTurn();
        AssignSegments();

        _title.Text = session.Title;
        _subtitle.Text = session.Project.Length > 0
            ? session.Project + "  ·  " + session.Preview
            : session.Preview;

        _composer.SetRunning(_agent.Run.State == RunState.Running);
        _timeline.ScrollToEnd();
    }

    // -----------------------------------------------------------------------------------------
    // Chrome
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Session header. Closed by a horizon rule — the flat form of the trace — so the boundary
    /// between chrome and canvas is the product's own line rather than a generic divider.
    /// </summary>
    private FrameworkElement BuildHeader()
    {
        var titles = Ui.VStack(2, _title, _subtitle);
        titles.VerticalAlignment = VerticalAlignment.Center;

        var more = Ui.IconButton("\uE712", "Session actions");
        more.Flyout = BuildSessionMenu();

        var runToggle = Ui.IconButton("\uE9D9", "Run panel  ·  Ctrl+R");
        runToggle.Click += (_, _) => ToggleRunPanel();

        var share = Ui.IconButton("\uE72D", "Share transcript");

        _headerUsage.Children.Add(UsageIndicator.Compact(_data.SessionUsage));

        var right = Ui.HStack(Tk.Sp.S4, _headerUsage, Ui.VDivider(), share, runToggle, more);
        right.HorizontalAlignment = HorizontalAlignment.Right;

        var row = new Grid { ColumnSpacing = Tk.Sp.S16 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        row.Children.Add(titles.At(0));
        row.Children.Add(right.At(1));

        var measured = new Border
        {
            MaxWidth = ReadingWidth,
            HorizontalAlignment = HorizontalAlignment.Center,
            Padding = new Thickness(Tk.Sp.S8, Tk.Sp.S10, Tk.Sp.S8, Tk.Sp.S10),
            Child = row,
        };

        var stack = new StackPanel { Orientation = Orientation.Vertical };
        stack.Children.Add(measured);
        stack.Children.Add(Ui.HorizonRule(0.38));

        return new Border
        {
            Background = Tk.FillPaper,
            Padding = new Thickness(Tk.Sp.S24, 0, Tk.Sp.S24, 0),
            Child = stack,
        };
    }

    private MenuFlyout BuildSessionMenu()
    {
        var flyout = new MenuFlyout();
        flyout.Items.Add(new MenuFlyoutItem { Text = "Rename session", Icon = new FontIcon { Glyph = "\uE8AC" } });
        flyout.Items.Add(new MenuFlyoutItem { Text = "Branch from latest turn", Icon = new FontIcon { Glyph = "\uE8AB" } });
        flyout.Items.Add(new MenuFlyoutSeparator());

        var scope = new MenuFlyoutSubItem { Text = "Allowed roots", Icon = new FontIcon { Glyph = "\uE8B7" } };
        scope.Items.Add(new ToggleMenuFlyoutItem { Text = "Services/Cyrene-Navigator", IsChecked = true });
        scope.Items.Add(new ToggleMenuFlyoutItem { Text = "~/.cyrene/harness/cache", IsChecked = true });
        scope.Items.Add(new MenuFlyoutItem { Text = "Add a root…" });
        flyout.Items.Add(scope);

        var export = new MenuFlyoutItem { Text = "Export transcript…", Icon = new FontIcon { Glyph = "\uE74E" } };
        export.Click += (_, _) => ExportTranscript();
        flyout.Items.Add(export);

        flyout.Items.Add(new MenuFlyoutSeparator());
        var clear = new MenuFlyoutItem { Text = "Delete session", Icon = new FontIcon { Glyph = "\uE74D" } };
        clear.Click += (_, _) => ConfirmDelete();
        flyout.Items.Add(clear);
        return flyout;
    }

    private FrameworkElement BuildComposerHost()
    {
        var measured = new Border
        {
            MaxWidth = ReadingWidth,
            HorizontalAlignment = HorizontalAlignment.Center,
            Padding = new Thickness(Tk.Sp.S8, 0, Tk.Sp.S8, 0),
            Child = _composer,
        };

        return new Border
        {
            Background = Tk.FillPaper,
            Padding = new Thickness(Tk.Sp.S24, Tk.Sp.S8, Tk.Sp.S24, Tk.Sp.S16),
            Child = measured,
        };
    }

    /// <summary>
    /// Optional right-hand run panel. Off by default: the inline run trace already answers "what
    /// is happening" without stealing width from the reading column. The panel exists for when
    /// you want to watch a long run while reading something else in the transcript.
    /// </summary>
    private Border BuildRunPanel()
    {
        var head = new Grid { Padding = new Thickness(Tk.Sp.S16, Tk.Sp.S12, Tk.Sp.S8, Tk.Sp.S8) };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Auto });
        head.Children.Add(Typo.Eyebrow("current run").At(0));

        var close = Ui.IconButton("\uE711", "Close run panel", 26);
        close.Click += (_, _) => ToggleRunPanel();
        head.Children.Add(close.At(1));

        var body = new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Disabled,
            Padding = new Thickness(Tk.Sp.S8, 0, Tk.Sp.S8, Tk.Sp.S16),
            Content = _runPanelContent,
        };

        var stack = new StackPanel { Orientation = Orientation.Vertical };
        stack.Children.Add(head);
        stack.Children.Add(Ui.Divider());
        stack.Children.Add(body);

        return new Border
        {
            Width = 340,
            Background = Tk.FillSand,
            BorderBrush = Tk.Line,
            BorderThickness = Tk.Ln.Left,
            Child = stack,
        };
    }

    private void ToggleRunPanel()
    {
        _runPanelOpen = !_runPanelOpen;
        _runPanelHost.Visibility = _runPanelOpen ? Visibility.Visible : Visibility.Collapsed;

        if (!_runPanelOpen)
        {
            _panelProgress = null;
            return;
        }

        _runPanelContent.Children.Clear();
        _panelProgress = new AgentProgress(_agent.Run, _data, showChrome: false)
        {
            Margin = new Thickness(0, Tk.Sp.S8, 0, Tk.Sp.S8),
        };
        _runPanelContent.Children.Add(_panelProgress);
        _runPanelContent.Children.Add(Ui.Divider(Tk.Sp.S8, Tk.Sp.S8));
        _runPanelContent.Children.Add(new Border
        {
            Padding = new Thickness(Tk.Sp.S8, 0, Tk.Sp.S8, 0),
            Child = Ui.VStack(Tk.Sp.S10,
                Typo.Eyebrow("this run"),
                UsageIndicator.Inline(_agent.Run.Usage)),
        });
        Ui.FadeIn(_runPanelHost, 180);
    }

    // -----------------------------------------------------------------------------------------
    // Trace layout
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Splits one continuous brand gradient across every row of the live region, so the spine
    /// reads as a single ramp rather than as one gradient repeated per row.
    /// </summary>
    private void AssignSegments()
    {
        _segments.Clear();
        var live = new List<TimelineItem>();
        foreach (var item in _items)
        {
            if (item.Trace == TraceRole.Live)
            {
                live.Add(item);
            }
        }

        for (var i = 0; i < live.Count; i++)
        {
            _segments[live[i].Id] = TraceGutter.Segment(i, live.Count);
        }
    }

    private (double T0, double T1) SegmentFor(TimelineItem item) =>
        _segments.TryGetValue(item.Id, out var value) ? value : (0, 1);

    // -----------------------------------------------------------------------------------------
    // Row factory
    // -----------------------------------------------------------------------------------------

    /// <summary>
    /// Builds one timeline row: trace gutter in column 0, content in column 1. Called on every
    /// container recycle, so it stays cheap — parsing and tokenizing are cached on the items.
    /// </summary>
    private FrameworkElement? BuildTimelineRow(object raw)
    {
        if (raw is not TimelineItem item)
        {
            return null;
        }

        if (item is DayDividerItem divider)
        {
            return Measured(TimelineMarks.Divider(divider.Label), 0, 0);
        }

        var (t0, t1) = SegmentFor(item);
        FrameworkElement content;
        double nodeOffset;
        double padTop;
        double padBottom;
        var elbow = false;

        switch (item)
        {
            case TurnItem turn:
                content = BuildTurn(turn);
                nodeOffset = 16;
                padTop = Tk.Sp.S12;
                padBottom = Tk.Sp.S12;
                break;

            case ToolItem tool:
                content = new ToolCard(tool, _data) { MaxWidth = MessageView.ProseWidth, HorizontalAlignment = HorizontalAlignment.Left };
                nodeOffset = 26;
                padTop = Tk.Sp.S4;
                padBottom = Tk.Sp.S4;
                elbow = true;
                break;

            case ApprovalItem approval:
            {
                var card = new ApprovalCard(approval)
                {
                    MaxWidth = MessageView.ProseWidth,
                    HorizontalAlignment = HorizontalAlignment.Left,
                };
                card.Decided += _ => _timeline.ScrollIntoView(approval);
                content = card;
                nodeOffset = 28;
                padTop = Tk.Sp.S12;
                padBottom = Tk.Sp.S12;
                elbow = true;
                break;
            }

            case ArtifactItem artifact:
                content = new ArtifactCard(artifact) { MaxWidth = MessageView.ProseWidth, HorizontalAlignment = HorizontalAlignment.Left };
                nodeOffset = 20;
                padTop = Tk.Sp.S10;
                padBottom = Tk.Sp.S10;
                elbow = true;
                break;

            case DiffItem diff:
                content = new DiffView(diff) { MaxWidth = MessageView.ProseWidth, HorizontalAlignment = HorizontalAlignment.Left };
                nodeOffset = 24;
                padTop = Tk.Sp.S8;
                padBottom = Tk.Sp.S8;
                elbow = true;
                break;

            case UsageItem usage:
                content = UsageIndicator.Inline(usage.Usage);
                nodeOffset = 14;
                padTop = 0;
                padBottom = Tk.Sp.S8;
                break;

            case NoticeItem notice:
                content = TimelineMarks.Notice(notice);
                nodeOffset = 14;
                padTop = Tk.Sp.S6;
                padBottom = Tk.Sp.S6;
                break;

            case RunItem:
            {
                _inlineRun = new AgentProgress(_agent.Run, _data);
                _inlineRun.StopRequested += OnStopRequested;
                content = _inlineRun;
                nodeOffset = 26;
                padTop = Tk.Sp.S12;
                padBottom = Tk.Sp.S12;
                elbow = true;
                break;
            }

            default:
                return null;
        }

        var row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Px(Tk.Sp.Gutter) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = Ui.Star() });

        row.Children.Add(new TraceGutter(
            item.Trace,
            item.Node,
            t0,
            t1,
            nodeOffset: nodeOffset + padTop,
            elbow: elbow).At(0));

        content.Margin = new Thickness(0, padTop, 0, padBottom);
        row.Children.Add(content.At(1));

        return Measured(row, 0, 0);
    }

    /// <summary>Constrains a row to the shared reading measure and centres it.</summary>
    private static FrameworkElement Measured(FrameworkElement content, double top, double bottom)
    {
        content.HorizontalAlignment = HorizontalAlignment.Stretch;
        return new Border
        {
            MaxWidth = ReadingWidth,
            HorizontalAlignment = HorizontalAlignment.Center,
            Padding = new Thickness(Tk.Sp.S32, top, Tk.Sp.S32, bottom),
            Child = content,
        };
    }

    private FrameworkElement BuildTurn(TurnItem turn)
    {
        var view = new MessageView(turn);

        if (turn.IsStreaming)
        {
            _streamingView = view;
            view.UpdateStreaming(_stream.Visible);
        }

        return view;
    }

    // -----------------------------------------------------------------------------------------
    // Live behaviour
    // -----------------------------------------------------------------------------------------

    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        StartClock();

        // Navigating away and back must not yank the reader to the bottom again.
        if (_opened)
        {
            return;
        }

        _opened = true;
        _timeline.ScrollToEnd();
        _composer.SetRunning(_agent.Run.State == RunState.Running);

        // The first ScrollIntoView happens before the panel has realised its containers, so the
        // final position needs one more pass once layout has settled.
        var settle = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(220) };
        settle.Tick += (_, _) =>
        {
            settle.Stop();
            _timeline.ScrollToEnd();
        };
        settle.Start();
    }

    /// <summary>
    /// One 90ms timer drives everything live: the agent trace, the streaming tail, and the
    /// elapsed clocks. A single tick source keeps the frame budget predictable and means a
    /// running session costs one timer, not one per animated element.
    /// </summary>
    private void StartClock()
    {
        _clock = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(90) };
        _clock.Tick += (_, _) =>
        {
            // Only the two trace views are redrawn, in place. Rebuilding the panel would reset
            // its scroll position every second and a third.
            if (_agent.Tick(TimeSpan.FromMilliseconds(90)))
            {
                _inlineRun?.Refresh();
                _panelProgress?.Refresh();
            }

            if (!_stream.Done)
            {
                _stream.Advance(9);
                _streamingView?.UpdateStreaming(_stream.Visible);
            }
            else if (_streamingTurn.IsStreaming)
            {
                _streamingTurn.IsStreaming = false;
                _streamingView?.FinishStreaming();
                _composer.SetRunning(_agent.Run.State == RunState.Running);
            }
        };
        _clock.Start();
    }

    private void OnSubmitted(string text)
    {
        if (!_service.CanSubmit)
        {
            ShowPortError(NavigatorApiError.NotConnected(
                "Sending a message",
                "this client has no Harness write path; compose the turn in a Harness-connected client."));
            return;
        }

        // Append the user's turn, then a fresh streaming reply. The live region grows by two
        // rows, so the gradient is re-split across it — the spine stays one continuous ramp.
        var user = new TurnItem
        {
            Id = "u-" + Guid.NewGuid().ToString("N")[..6],
            At = DateTimeOffset.Now,
            Role = TurnRole.User,
            Author = "You",
            Markdown = text,
            Trace = TraceRole.Live,
            Node = NodeKind.Anchor,
        };

        _streamingTurn = new TurnItem
        {
            Id = "a-" + Guid.NewGuid().ToString("N")[..6],
            At = DateTimeOffset.Now,
            Role = TurnRole.Assistant,
            Author = "Cyrene",
            ModelLabel = _composer.Model.Current.Name,
            IsStreaming = true,
            Markdown = string.Empty,
            Trace = TraceRole.Live,
        };

        _items.Add(user);
        _items.Add(_streamingTurn);
        AssignSegments();

        _stream = _service.StreamingTail();
        _stream.Reset();
        _streamingView = null;

        _agent.Restart();
        _composer.SetRunning(true);
        _timeline.ScrollToEnd();
    }

    private void OnStopRequested()
    {
        try
        {
            _agent.Stop();
        }
        catch (NavigatorApiError error)
        {
            ShowPortError(error);
            return;
        }

        _inlineRun?.Refresh();
        _streamingTurn.IsStreaming = false;
        _streamingView?.FinishStreaming();
        _composer.SetRunning(false);
    }

    private void OnModelChanged(ModelDescriptor model)
    {
        var notice = new NoticeItem
        {
            Id = "n-" + Guid.NewGuid().ToString("N")[..6],
            At = DateTimeOffset.Now,
            Text = "Model switched to " + model.Name,
            Detail = _data.TierNote(model.Tier),
            Trace = TraceRole.Live,
        };
        _items.Insert(_items.Count - 1, notice);
        AssignSegments();
    }

    private TurnItem FindStreamingTurn()
    {
        for (var i = _items.Count - 1; i >= 0; i--)
        {
            if (_items[i] is TurnItem turn && turn.IsStreaming)
            {
                return turn;
            }
        }

        return new TurnItem { Id = "none" };
    }

    // -----------------------------------------------------------------------------------------
    // Native dialogs
    // -----------------------------------------------------------------------------------------

    private async void ExportTranscript()
    {
        try
        {
            var picker = AppHost.SavePicker("harness-session-contract-rename", "Markdown", ".md");
            var file = await picker.PickSaveFileAsync();
            if (file is null)
            {
                return;
            }

            var text = new System.Text.StringBuilder();
            text.AppendLine("# Harness session contract rename").AppendLine();
            foreach (var item in _items)
            {
                if (item is TurnItem turn && !string.IsNullOrWhiteSpace(turn.Markdown))
                {
                    text.AppendLine($"## {turn.Author} · {Ui.Clock(turn.At)}").AppendLine();
                    text.AppendLine(turn.Markdown).AppendLine();
                }
            }

            await FileIO.WriteTextAsync(file, text.ToString());
        }
        catch (Exception)
        {
            // The picker needs a live window; nothing actionable if it has closed.
        }
    }

    /// <summary>
    /// Surfaces a typed port failure. Control actions either reach their owner or are shown as
    /// not connected — they never change local state on their own.
    /// </summary>
    private async void ShowPortError(NavigatorApiError error)
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

    private async void ConfirmDelete()
    {
        var body = Ui.VStack(Tk.Sp.S8,
            Typo.Body("This removes the transcript, its artifacts and its run history from this device."),
            Typo.Meta("68 turns · 3 artifacts · 63 tool calls", Tk.TextMuted));

        var dialog = AppHost.Dialog("Delete this session?", body, "Delete", null, "Cancel");
        if (dialog is null)
        {
            return;
        }

        dialog.PrimaryButtonStyle = DangerButtonStyle();
        await dialog.ShowAsync();
    }

    private static Style DangerButtonStyle()
    {
        var style = new Style(typeof(Button));
        style.Setters.Add(new Setter(Control.BackgroundProperty, Tk.Danger));
        style.Setters.Add(new Setter(Control.ForegroundProperty, Tk.TextOnInk));
        style.Setters.Add(new Setter(Control.BorderThicknessProperty, Tk.Ln.None));
        style.Setters.Add(new Setter(Control.CornerRadiusProperty, Tk.Rad.Xs));
        return style;
    }
}
