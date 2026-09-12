// Core/Models.cs
//
// Product-layer data shapes for the Navigator prototype / Navigator 原型的产品层数据结构。
//
// These are deliberately plain: no INotifyPropertyChanged plumbing, no service coupling, no
// dependency on any UI type. The timeline is a flat list of heterogeneous items because that
// is what a virtualized timeline needs — one item, one row, one recycled container.
//
// 这些类型只描述数据形状，将来换成真实 API 时替换 Mock* 服务即可，不影响控件层。

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core;

// ---------------------------------------------------------------------------------------------
// Trace semantics
// ---------------------------------------------------------------------------------------------

/// <summary>
/// How a timeline row should draw its slice of the vertical trace line.
///
/// The trace is the product's core visual motif: a hairline that runs down the left gutter of
/// the conversation and brightens into the brand gradient as it approaches "now".
/// </summary>
public enum TraceRole
{
    /// <summary>No spine (day dividers, the very first row).</summary>
    None,

    /// <summary>Settled history. Plain hairline, minimum visual weight.</summary>
    Settled,

    /// <summary>The transition row: hairline at the top, brand gradient at the bottom.</summary>
    Rise,

    /// <summary>Inside the live region. Full brand gradient.</summary>
    Live,

    /// <summary>Not reached yet. Dashed hairline.</summary>
    Pending,
}

/// <summary>Meaning carried by the diamond node on a timeline row.</summary>
public enum NodeKind
{
    /// <summary>No node — the spine just passes through.</summary>
    None,

    /// <summary>A settled anchor: hollow diamond, hairline stroke.</summary>
    Anchor,

    /// <summary>Something worth noticing later: hollow diamond, orchid stroke.</summary>
    Marked,

    /// <summary>Happening now: gradient-filled diamond with a halo.</summary>
    Active,

    /// <summary>Completed successfully.</summary>
    Done,

    /// <summary>Failed.</summary>
    Failed,

    /// <summary>Blocked on a human decision.</summary>
    Blocked,
}

// ---------------------------------------------------------------------------------------------
// Conversation timeline
// ---------------------------------------------------------------------------------------------

public enum TurnRole
{
    User,
    Assistant,
}

/// <summary>Base type for one row of the virtualized conversation timeline.</summary>
public abstract class TimelineItem
{
    public string Id { get; init; } = string.Empty;

    public DateTimeOffset At { get; init; }

    public TraceRole Trace { get; set; } = TraceRole.Settled;

    public NodeKind Node { get; set; } = NodeKind.None;
}

/// <summary>A user or assistant message. Markdown is parsed lazily and cached here.</summary>
public sealed class TurnItem : TimelineItem
{
    public TurnRole Role { get; init; }

    public string Author { get; init; } = string.Empty;

    /// <summary>Model that produced an assistant turn; empty for user turns.</summary>
    public string ModelLabel { get; init; } = string.Empty;

    public string Markdown { get; init; } = string.Empty;

    /// <summary>True while tokens are still arriving; the view shows a gradient caret.</summary>
    public bool IsStreaming { get; set; }

    /// <summary>Short collapsed reasoning summary, shown as a foldaway line above the body.</summary>
    public string? ThoughtSummary { get; init; }

    /// <summary>
    /// Parsed representation, produced once on first render. Re-parsing markdown on every
    /// container recycle is the classic reason chat clients stutter while scrolling.
    /// </summary>
    public object? ParsedCache { get; set; }
}

public enum ToolKind
{
    ReadFile,
    EditFile,
    Search,
    Shell,
    NativeTool,
    Connector,
    Http,
    Test,
    Browser,
}

public enum ToolOutcome
{
    Running,
    Ok,
    Failed,
    Denied,
    Skipped,
}

/// <summary>A single tool invocation and its result, rendered as one collapsible card.</summary>
public sealed class ToolItem : TimelineItem
{
    public ToolKind Kind { get; init; }

    /// <summary>Tool identifier as the runtime would report it, e.g. <c>fs.read</c>.</summary>
    public string Name { get; init; } = string.Empty;

    /// <summary>What it acted on: a path, a command, an endpoint.</summary>
    public string Target { get; init; } = string.Empty;

    /// <summary>One-line human summary of the result, always visible when collapsed.</summary>
    public string Summary { get; set; } = string.Empty;

    public ToolOutcome Outcome { get; set; } = ToolOutcome.Ok;

    public TimeSpan Duration { get; set; }

    /// <summary>Request payload, shown when expanded.</summary>
    public string Request { get; init; } = string.Empty;

    /// <summary>Response body, shown when expanded. Never expanded by default.</summary>
    public string Response { get; set; } = string.Empty;

    public string ResponseLanguage { get; init; } = "text";

    /// <summary>Where the tool ran. Surfacing this is a Cyrene differentiator.</summary>
    public string Origin { get; init; } = "local";

    public bool StartExpanded { get; set; }

    public object? ResponseTokenCache { get; set; }
}

public enum ApprovalRisk
{
    Routine,
    Elevated,
}

/// <summary>A blocking human decision. Rendered as a gradient-edged decision card.</summary>
public sealed class ApprovalItem : TimelineItem
{
    public string Title { get; init; } = string.Empty;

    public string Rationale { get; init; } = string.Empty;

    public ToolKind Kind { get; init; }

    public string Command { get; init; } = string.Empty;

    public string CommandLanguage { get; init; } = "bash";

    public ApprovalRisk Risk { get; init; } = ApprovalRisk.Elevated;

    /// <summary>Facts the user needs in order to decide, as label/value pairs.</summary>
    public IReadOnlyList<(string Label, string Value)> Facts { get; init; } =
        Array.Empty<(string, string)>();

    /// <summary>Null while pending; otherwise the recorded decision.</summary>
    public string? Decision { get; set; }
}

public enum ArtifactKind
{
    Document,
    Code,
    Data,
    Diagram,
    Image,
    Archive,
}

/// <summary>Something the run produced that outlives the conversation.</summary>
public sealed class ArtifactItem : TimelineItem
{
    public string Title { get; init; } = string.Empty;

    public ArtifactKind Kind { get; init; }

    public string Subtitle { get; init; } = string.Empty;

    public string SizeLabel { get; init; } = string.Empty;

    /// <summary>A few lines of preview so the card is useful without opening anything.</summary>
    public string Preview { get; init; } = string.Empty;

    public string PreviewLanguage { get; init; } = "text";

    public IReadOnlyList<string> Tags { get; init; } = Array.Empty<string>();
}

/// <summary>A unified diff produced by an edit, rendered with a +/- gutter.</summary>
public sealed class DiffItem : TimelineItem
{
    public string Path { get; init; } = string.Empty;

    public string Language { get; init; } = "text";

    public int Added { get; init; }

    public int Removed { get; init; }

    /// <summary>Unified diff text including <c>@@</c> hunk headers.</summary>
    public string Patch { get; init; } = string.Empty;
}

/// <summary>Token/cost accounting attached to the end of an assistant turn.</summary>
public sealed class UsageItem : TimelineItem
{
    public UsageSnapshot Usage { get; init; } = new();
}

/// <summary>The live agent run, rendered inline as a trace of steps.</summary>
public sealed class RunItem : TimelineItem
{
    public AgentRun Run { get; init; } = new();
}

/// <summary>Date separator inside the timeline.</summary>
public sealed class DayDividerItem : TimelineItem
{
    public string Label { get; init; } = string.Empty;
}

/// <summary>Context change notice, e.g. a model switch mid-session.</summary>
public sealed class NoticeItem : TimelineItem
{
    public string Text { get; init; } = string.Empty;

    public string? Detail { get; init; }
}

// ---------------------------------------------------------------------------------------------
// Agent run
// ---------------------------------------------------------------------------------------------

public enum StepState
{
    Pending,
    Running,
    Done,
    Failed,
    Skipped,
}

/// <summary>
/// One step of an agent run. Steps nest one level deep: a phase such as "Search repository"
/// owns the individual tool calls it made. Branching sub-steps are what make the trace read
/// as a path rather than a log.
/// </summary>
public sealed class AgentStep
{
    public string Id { get; init; } = string.Empty;

    public string Title { get; init; } = string.Empty;

    /// <summary>Live detail line, e.g. the command currently executing.</summary>
    public string Detail { get; set; } = string.Empty;

    public StepState State { get; set; } = StepState.Pending;

    public ToolKind? Tool { get; init; }

    public TimeSpan Elapsed { get; set; }

    public IList<AgentStep> Children { get; init; } = new List<AgentStep>();
}

public enum RunState
{
    Idle,
    Running,
    AwaitingApproval,
    Failed,
    Done,
    Cancelled,
}

/// <summary>Everything the UI needs to explain "what is happening right now".</summary>
public sealed class AgentRun
{
    public string Id { get; init; } = string.Empty;

    public string AgentName { get; init; } = "Cyrene Agent";

    public string Goal { get; init; } = string.Empty;

    public string ModelLabel { get; init; } = string.Empty;

    public RunState State { get; set; } = RunState.Running;

    public TimeSpan Elapsed { get; set; }

    public IList<AgentStep> Steps { get; init; } = new List<AgentStep>();

    public UsageSnapshot Usage { get; set; } = new();

    /// <summary>Index of the step the user should be looking at.</summary>
    public int CurrentIndex
    {
        get
        {
            for (var i = 0; i < Steps.Count; i++)
            {
                if (Steps[i].State == StepState.Running || Steps[i].State == StepState.Failed)
                {
                    return i;
                }
            }

            return Steps.Count - 1;
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Sessions, models, usage, workspace
// ---------------------------------------------------------------------------------------------

public enum SessionActivity
{
    Idle,
    Running,
    AwaitingApproval,
    Failed,
}

public sealed class SessionSummary
{
    public string Id { get; init; } = string.Empty;

    public string Title { get; init; } = string.Empty;

    public string Project { get; init; } = string.Empty;

    /// <summary>Last message or current step, whichever is more useful.</summary>
    public string Preview { get; init; } = string.Empty;

    public DateTimeOffset UpdatedAt { get; init; }

    public SessionActivity Activity { get; init; } = SessionActivity.Idle;

    public string ModelLabel { get; init; } = string.Empty;

    public int TurnCount { get; init; }

    public bool IsPinned { get; init; }

    /// <summary>Grouping bucket already resolved by the service ("Now", "Today", ...).</summary>
    public string Bucket { get; init; } = "Earlier";
}

public enum ModelTier
{
    /// <summary>Third-party hosted API.</summary>
    Hosted,

    /// <summary>Served from this workspace's own GPU pool.</summary>
    Workspace,

    /// <summary>Running on this machine through the Navigator native host.</summary>
    Local,
}

public sealed class ModelDescriptor
{
    public string Id { get; init; } = string.Empty;

    public string Name { get; init; } = string.Empty;

    public string Provider { get; init; } = string.Empty;

    public ModelTier Tier { get; init; }

    public string ContextLabel { get; init; } = string.Empty;

    public string CostLabel { get; init; } = string.Empty;

    /// <summary>Short editorial line, in the spirit of the brand's model taglines.</summary>
    public string Tagline { get; init; } = string.Empty;

    public bool Vision { get; init; }

    public bool Tools { get; init; }

    public bool Thinking { get; init; }

    /// <summary>Null when the model is available; otherwise why it is not selectable.</summary>
    public string? Unavailable { get; init; }
}

public sealed class UsageSnapshot
{
    /// <summary>
    /// True only when the connected service actually reported usage for the scope in question.
    /// An unreported snapshot renders as "not reported" instead of zeros that read like facts.
    /// </summary>
    public bool Reported { get; init; }

    public int InputTokens { get; init; }

    public int OutputTokens { get; init; }

    public int CachedTokens { get; init; }

    /// <summary>Fraction of the context window consumed, 0..1.</summary>
    public double ContextUsed { get; init; }

    public double CostUsd { get; init; }

    public TimeSpan Latency { get; init; }

    public int ToolCalls { get; init; }

    public int Total => InputTokens + OutputTokens;
}

public enum ResourceHealth
{
    Healthy,
    Busy,
    Degraded,
    Offline,
}

/// <summary>A row in the workspace resource sheets (users, models, nodes, endpoints).</summary>
public sealed class ResourceRow
{
    public string Primary { get; init; } = string.Empty;

    public string Secondary { get; init; } = string.Empty;

    public string Metric { get; init; } = string.Empty;

    public string MetricLabel { get; init; } = string.Empty;

    public ResourceHealth Health { get; init; } = ResourceHealth.Healthy;

    /// <summary>Normalised 0..1 load, drawn as a hairline bar.</summary>
    public double Load { get; init; }
}

/// <summary>
/// One labelled sheet of resource rows on the workspace page. The section text and its rows are
/// service data: views render whatever the connected source reports and never invent a sheet.
/// </summary>
public sealed class ResourceSection
{
    public string Eyebrow { get; init; } = string.Empty;

    public string Title { get; init; } = string.Empty;

    public string Note { get; init; } = string.Empty;

    public IReadOnlyList<ResourceRow> Rows { get; init; } = Array.Empty<ResourceRow>();
}

public sealed class MetricCard
{
    public string Label { get; init; } = string.Empty;

    public string Value { get; init; } = string.Empty;

    public string Unit { get; init; } = string.Empty;

    public string Delta { get; init; } = string.Empty;

    /// <summary>Sparkline samples, already normalised to 0..1.</summary>
    public IReadOnlyList<double> Series { get; init; } = Array.Empty<double>();
}
