// Core/Api/NavigatorEventProjection.cs
//
// Pure Harness-event projection / Harness 事件纯投影。
//
// The Navigator persistence service stores the upstream Harness event log verbatim. This file
// is the only place that reads those events, and it never rewrites them: it projects the event
// types the client understands into product shapes and ignores everything else. No WinUI type
// is referenced here, so the projection is testable without Windows.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;

namespace Cyrene.Navigator.Windows.Core.Api;

/// <summary>Everything the UI needs derived from one committed event slice.</summary>
public sealed class NavigatorProjection
{
    public IReadOnlyList<TimelineItem> Timeline { get; init; } = Array.Empty<TimelineItem>();

    public AgentRun Run { get; init; } = NavigatorEventProjection.IdleRun;

    public ApprovalItem? PendingApproval { get; init; }

    public UsageSnapshot Usage { get; init; } = new();
}

public static class NavigatorEventProjection
{
    /// <summary>
    /// An explicit idle run: nothing is running because the service reported nothing. A factory
    /// property, not a shared instance, so no caller can mutate another caller's state.
    /// </summary>
    public static AgentRun IdleRun => new()
    {
        Id = "idle",
        Goal = string.Empty,
        State = RunState.Idle,
    };

    /// <summary>Projects one committed event slice into timeline, run, approval and usage facts.</summary>
    public static NavigatorProjection Project(IReadOnlyList<SessionEventRecord> events)
    {
        var timeline = new List<TimelineItem>();
        var toolItems = new Dictionary<string, ToolItem>(StringComparer.Ordinal);
        var steps = new List<AgentStep>();
        var stepByKey = new Dictionary<string, AgentStep>(StringComparer.Ordinal);
        var stepStartedAt = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        var childrenByCallId = new Dictionary<string, AgentStep>(StringComparer.Ordinal);
        var callStartedAt = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);
        var run = new AgentRun { Id = "idle", Goal = string.Empty, State = RunState.Idle };
        ApprovalItem? pendingApproval = null;

        foreach (var record in events)
        {
            var at = Timestamp(record.Time);
            switch (record.Type)
            {
                case "turn/start":
                {
                    var turn = ReadInt(record.Data, "turn") ?? 1;
                    run = new AgentRun
                    {
                        Id = "turn-" + turn.ToString(CultureInfo.InvariantCulture),
                        Goal = string.Empty,
                        State = RunState.Running,
                        Steps = new List<AgentStep>(),
                    };
                    steps = new List<AgentStep>();
                    stepByKey.Clear();
                    stepStartedAt.Clear();
                    childrenByCallId.Clear();
                    callStartedAt.Clear();
                    break;
                }

                case "step/start":
                {
                    var key = StepKey(record.Data);
                    var step = new AgentStep
                    {
                        Id = key,
                        Title = "Step " + (ReadInt(record.Data, "step") ?? steps.Count + 1)
                            .ToString(CultureInfo.InvariantCulture),
                        State = StepState.Running,
                    };
                    steps.Add(step);
                    if (key.Length > 0)
                    {
                        stepByKey[key] = step;
                        stepStartedAt[key] = at;
                    }

                    break;
                }

                case "step/end":
                {
                    var key = StepKey(record.Data);
                    if (stepByKey.TryGetValue(key, out var step) && step.State == StepState.Running)
                    {
                        step.State = StepState.Done;
                        if (stepStartedAt.TryGetValue(key, out var startedAt) && at > startedAt)
                        {
                            step.Elapsed = at - startedAt;
                        }
                    }

                    break;
                }

                case "user/message":
                {
                    var text = ReadContentText(Value(record.Data, "content"));
                    if (text.Length > 0)
                    {
                        timeline.Add(new TurnItem
                        {
                            Id = "e" + record.Seq.ToString(CultureInfo.InvariantCulture),
                            At = at,
                            Role = TurnRole.User,
                            Author = "You",
                            Markdown = text,
                        });
                    }

                    break;
                }

                case "assistant/message":
                {
                    var message = Value(record.Data, "message");
                    var text = ReadContentText(Value(message, "content"));
                    var model = ReadNestedString(message, "source", "model") ?? string.Empty;
                    if (text.Length > 0)
                    {
                        timeline.Add(new TurnItem
                        {
                            Id = "e" + record.Seq.ToString(CultureInfo.InvariantCulture),
                            At = at,
                            Role = TurnRole.Assistant,
                            Author = "Cyrene",
                            ModelLabel = model,
                            Markdown = text,
                        });
                    }

                    break;
                }

                case "tool/call":
                {
                    var callId = ReadString(record.Data, "callId") ?? string.Empty;
                    var name = ReadString(record.Data, "name") ?? "tool";
                    var arguments = ReadString(record.Data, "arguments") ?? string.Empty;
                    var item = new ToolItem
                    {
                        Id = "e" + record.Seq.ToString(CultureInfo.InvariantCulture),
                        At = at,
                        Kind = InferToolKind(name),
                        Name = name,
                        Target = FirstLine(arguments),
                        Summary = "running",
                        Outcome = ToolOutcome.Running,
                        Request = arguments,
                        Origin = "harness",
                    };
                    timeline.Add(item);
                    if (callId.Length > 0)
                    {
                        toolItems[callId] = item;
                    }

                    var child = new AgentStep
                    {
                        Id = "call-" + callId,
                        Title = name,
                        Detail = FirstLine(arguments),
                        Tool = item.Kind,
                        State = StepState.Running,
                    };
                    childrenByCallId[callId] = child;
                    callStartedAt[callId] = at;
                    if (steps.Count > 0)
                    {
                        steps[^1].Children.Add(child);
                    }
                    else
                    {
                        steps.Add(child);
                    }

                    break;
                }

                case "tool/result":
                {
                    var message = Value(record.Data, "message");
                    var callId = ReadString(message, "callId")
                        ?? ReadString(record.Data, "callId")
                        ?? string.Empty;
                    var resultText = ReadContentText(Value(message, "content"));
                    var failed = ReadBool(message, "isError");
                    ToolItem? item = null;
                    if (callId.Length > 0)
                    {
                        toolItems.TryGetValue(callId, out item);
                    }

                    var summary = FirstLine(resultText);
                    if (item is not null)
                    {
                        item.Outcome = failed ? ToolOutcome.Failed : ToolOutcome.Ok;
                        item.Summary = summary.Length > 0 ? summary : "completed";
                        item.Response = resultText;
                        item.Duration = item.At >= at ? TimeSpan.Zero : at - item.At;
                    }
                    else
                    {
                        timeline.Add(new NoticeItem
                        {
                            Id = "e" + record.Seq.ToString(CultureInfo.InvariantCulture),
                            At = at,
                            Text = failed ? "Tool failed" : "Tool completed",
                            Detail = summary,
                        });
                    }

                    if (callId.Length > 0 && childrenByCallId.TryGetValue(callId, out var child))
                    {
                        child.State = failed ? StepState.Failed : StepState.Done;
                        child.Detail = summary;
                        if (callStartedAt.TryGetValue(callId, out var startedAt) && at > startedAt)
                        {
                            child.Elapsed = at - startedAt;
                        }
                    }

                    break;
                }

                case "turn/end":
                {
                    var reason = ReadNestedString(record.Data, "reason", "kind") ?? "completed";
                    run.State = reason switch
                    {
                        "cancelled" => RunState.Cancelled,
                        "failed" or "error" => RunState.Failed,
                        "awaiting_approval" => RunState.AwaitingApproval,
                        _ => RunState.Done,
                    };
                    Settle(steps, run.State);
                    break;
                }

                default:
                {
                    if (record.Type.Contains("approval", StringComparison.OrdinalIgnoreCase))
                    {
                        var decision = ReadString(record.Data, "decision");
                        var approval = new ApprovalItem
                        {
                            Id = "e" + record.Seq.ToString(CultureInfo.InvariantCulture),
                            At = at,
                            Title = ReadString(record.Data, "title")
                                ?? ReadString(record.Data, "reason")
                                ?? "Approval required",
                            Rationale = ReadString(record.Data, "detail")
                                ?? ReadString(record.Data, "rationale")
                                ?? string.Empty,
                            Command = ReadString(record.Data, "command") ?? string.Empty,
                            Risk = ApprovalRisk.Elevated,
                            Decision = decision,
                        };
                        timeline.Add(approval);
                        if (string.IsNullOrEmpty(decision))
                        {
                            pendingApproval = approval;
                        }
                    }

                    break;
                }
            }
        }

        if (pendingApproval is not null && run.State != RunState.Cancelled)
        {
            run.State = RunState.AwaitingApproval;
        }

        run.Steps.Clear();
        foreach (var step in steps)
        {
            run.Steps.Add(step);
        }

        AssignTrace(timeline);
        return new NavigatorProjection
        {
            Timeline = timeline,
            Run = run,
            PendingApproval = pendingApproval,
            Usage = new UsageSnapshot(),
        };
    }

    /// <summary>Projects one session list entry; the list API carries no message content.</summary>
    public static SessionSummary Summarize(SessionSnapshotRecord snapshot, DateTimeOffset now)
    {
        var id = ReadMetaString(snapshot, "id") ?? string.Empty;
        var cwd = ReadMetaString(snapshot, "cwd") ?? string.Empty;
        var updated = snapshot.LastActivityAt is long milliseconds
            ? DateTimeOffset.FromUnixTimeMilliseconds(milliseconds)
            : now;
        return new SessionSummary
        {
            Id = id,
            Title = LeafName(cwd).Length > 0 ? LeafName(cwd) : (id.Length > 0 ? id : "session"),
            Project = cwd,
            Preview = snapshot.EventCount.ToString(CultureInfo.InvariantCulture) + " committed events",
            UpdatedAt = updated,
            Activity = SessionActivity.Idle,
            ModelLabel = string.Empty,
            TurnCount = 0,
            Bucket = Bucket(updated, now),
        };
    }

    // -----------------------------------------------------------------------------------------

    private static void Settle(List<AgentStep> steps, RunState state)
    {
        foreach (var step in steps)
        {
            SettleOne(step, state);
        }
    }

    private static void SettleOne(AgentStep step, RunState state)
    {
        if (step.State == StepState.Running)
        {
            step.State = state == RunState.Failed ? StepState.Failed : StepState.Done;
        }

        foreach (var child in step.Children)
        {
            SettleOne(child, state);
        }
    }

    /// <summary>Marks settled history and the live tail the way the trace design expects.</summary>
    private static void AssignTrace(List<TimelineItem> timeline)
    {
        for (var i = 0; i < timeline.Count; i++)
        {
            var item = timeline[i];
            var isLive = item switch
            {
                ToolItem tool => tool.Outcome == ToolOutcome.Running,
                ApprovalItem approval => approval.Decision is null,
                _ => false,
            };
            item.Trace = isLive ? TraceRole.Live : TraceRole.Settled;
            item.Node = item switch
            {
                ApprovalItem => NodeKind.Blocked,
                ToolItem tool when tool.Outcome == ToolOutcome.Failed => NodeKind.Failed,
                ToolItem tool when tool.Outcome == ToolOutcome.Running => NodeKind.Active,
                _ => NodeKind.None,
            };
        }
    }

    private static string StepKey(JsonElement data)
    {
        var turn = ReadInt(data, "turn");
        var step = ReadInt(data, "step");
        return turn is null || step is null
            ? string.Empty
            : turn.Value.ToString(CultureInfo.InvariantCulture)
                + ":" + step.Value.ToString(CultureInfo.InvariantCulture);
    }

    private static string ReadContentText(JsonElement content)
    {
        if (content.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var parts = new List<string>();
        foreach (var item in content.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object
                && ReadString(item, "type") == "text"
                && ReadString(item, "text") is string text
                && text.Length > 0)
            {
                parts.Add(text);
            }
        }

        return string.Join("\n", parts);
    }

    private static JsonElement Value(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value)
            ? value
            : default;

    private static string? ReadString(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? ReadInt(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var number)
            ? number
            : null;

    private static bool ReadBool(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.True;

    private static string? ReadNestedString(JsonElement element, string outer, string inner) =>
        ReadString(Value(element, outer), inner);

    private static string? ReadMetaString(SessionSnapshotRecord snapshot, string name) =>
        ReadString(snapshot.Meta, name);

    private static string FirstLine(string value)
    {
        var index = value.IndexOfAny(new[] { '\r', '\n' });
        var line = index < 0 ? value : value[..index];
        return line.Length > 160 ? line[..160] : line;
    }

    private static string LeafName(string path)
    {
        if (path.Length == 0)
        {
            return string.Empty;
        }

        var trimmed = path.TrimEnd('/', '\\');
        var index = trimmed.LastIndexOfAny(new[] { '/', '\\' });
        return index < 0 ? trimmed : trimmed[(index + 1)..];
    }

    private static string Bucket(DateTimeOffset updated, DateTimeOffset now)
    {
        if (updated >= now.AddHours(-6))
        {
            return "Now";
        }

        return updated >= now.AddDays(-1) ? "Today" : "Earlier";
    }

    /// <summary>
    /// Tool family is presentation inference from the tool name, never a capability claim.
    /// </summary>
    private static ToolKind InferToolKind(string name)
    {
        var lowered = name.ToLowerInvariant();
        if (lowered.Contains("read") || lowered.Contains("fetch") || lowered.Contains("open"))
        {
            return ToolKind.ReadFile;
        }

        if (lowered.Contains("edit") || lowered.Contains("write") || lowered.Contains("patch"))
        {
            return ToolKind.EditFile;
        }

        if (lowered.Contains("search") || lowered.Contains("grep") || lowered.Contains("glob"))
        {
            return ToolKind.Search;
        }

        if (lowered.Contains("shell") || lowered.Contains("exec") || lowered.Contains("bash"))
        {
            return ToolKind.Shell;
        }

        if (lowered.Contains("test"))
        {
            return ToolKind.Test;
        }

        if (lowered.Contains("http") || lowered.Contains("request"))
        {
            return ToolKind.Http;
        }

        if (lowered.Contains("browser") || lowered.Contains("web"))
        {
            return ToolKind.Browser;
        }

        if (lowered.Contains("connector") || lowered.Contains("mcp"))
        {
            return ToolKind.Connector;
        }

        return ToolKind.NativeTool;
    }

    private static DateTimeOffset Timestamp(long milliseconds) =>
        milliseconds <= 0
            ? DateTimeOffset.UnixEpoch
            : DateTimeOffset.FromUnixTimeMilliseconds(milliseconds);
}
