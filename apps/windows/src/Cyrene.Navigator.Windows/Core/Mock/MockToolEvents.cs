// Core/Mock/MockToolEvents.cs
//
// Mock tool invocations / 工具调用（mock）。
//
// The four tool families the prototype has to prove it can render legibly:
//   file access, shell execution, Rust native tools, and external connectors.
// Plus the two states that usually get designed badly: a failure, and a blocked approval.
//
// 每个工具卡片默认折叠，只保留一行结论；展开才显示请求/响应 —— 长输出不应该默认铺开。

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Mock;

public static class MockToolEvents
{
    public static ToolItem Read(string path, string summary, string body, string language = "python", int ms = 42) => new()
    {
        Id = NextId(),
        Kind = ToolKind.ReadFile,
        Name = "fs.read",
        Target = path,
        Summary = summary,
        Outcome = ToolOutcome.Ok,
        Duration = TimeSpan.FromMilliseconds(ms),
        Request = "{\n  \"path\": \"" + path + "\",\n  \"encoding\": \"utf-8\"\n}",
        Response = body,
        ResponseLanguage = language,
        Origin = "native host · fs",
    };

    public static ToolItem Search(string query, string summary, string body, int ms = 118) => new()
    {
        Id = NextId(),
        Kind = ToolKind.Search,
        Name = "code.search",
        Target = query,
        Summary = summary,
        Outcome = ToolOutcome.Ok,
        Duration = TimeSpan.FromMilliseconds(ms),
        Request = "{\n  \"pattern\": \"" + query.Replace("\"", "\\\"") + "\",\n  \"scope\": \"workspace\",\n  \"max_results\": 200\n}",
        Response = body,
        ResponseLanguage = "text",
        Origin = "native host · ripgrep",
    };

    public static ToolItem Shell(string command, string summary, string body, ToolOutcome outcome = ToolOutcome.Ok, int ms = 8_310) => new()
    {
        Id = NextId(),
        Kind = ToolKind.Shell,
        Name = "shell.exec",
        Target = command,
        Summary = summary,
        Outcome = outcome,
        Duration = TimeSpan.FromMilliseconds(ms),
        Request = "$ " + command,
        Response = body,
        ResponseLanguage = "bash",
        Origin = "native host · pty",
    };

    public static ToolItem Native(string name, string target, string summary, string body, int ms = 6) => new()
    {
        Id = NextId(),
        Kind = ToolKind.NativeTool,
        Name = name,
        Target = target,
        Summary = summary,
        Outcome = ToolOutcome.Ok,
        Duration = TimeSpan.FromMilliseconds(ms),
        Request = "{\n  \"tool\": \"" + name + "\",\n  \"args\": { \"target\": \"" + target + "\" }\n}",
        Response = body,
        ResponseLanguage = "json",
        Origin = "example-native-host 0.4.2 · rust",
    };

    public static ToolItem Connector(string name, string target, string summary, string body, ToolOutcome outcome, int ms) => new()
    {
        Id = NextId(),
        Kind = ToolKind.Connector,
        Name = name,
        Target = target,
        Summary = summary,
        Outcome = outcome,
        Duration = TimeSpan.FromMilliseconds(ms),
        Request = "GET " + target + "\nauthorization: Bearer ••••••••\nx-cyrene-workspace: demo-workspace",
        Response = body,
        ResponseLanguage = "json",
        Origin = "exchange.example.invalid · external",
    };

    /// <summary>
    /// The failure case. A failed tool must read as one calm line plus an expandable cause —
    /// not as a stack trace dumped into the transcript.
    /// </summary>
    public static ToolItem FailedConnector() => new()
    {
        Id = NextId(),
        Kind = ToolKind.Connector,
        Name = "exchange.catalog.list",
        Target = "https://exchange.example.invalid/v1/catalog?kind=harness",
        Summary = "503 from upstream after 3 retries — falling back to the cached catalogue",
        Outcome = ToolOutcome.Failed,
        Duration = TimeSpan.FromMilliseconds(14_206),
        Request = "GET /v1/catalog?kind=harness\nauthorization: Bearer ••••••••\nx-cyrene-workspace: demo-workspace\nx-retry: 3",
        Response = "{\n  \"error\": {\n    \"code\": \"upstream_unavailable\",\n    \"status\": 503,\n    \"message\": \"catalog shard demo-shard-1 is draining\",\n    \"retry_after_seconds\": 120,\n    \"request_id\": \"req_01JQ8Z7X4M2N\"\n  },\n  \"attempts\": [\n    { \"at\": \"14:31:52Z\", \"status\": 503, \"elapsed_ms\": 4102 },\n    { \"at\": \"14:32:01Z\", \"status\": 503, \"elapsed_ms\": 4880 },\n    { \"at\": \"14:32:12Z\", \"status\": 503, \"elapsed_ms\": 5224 }\n  ]\n}",
        ResponseLanguage = "json",
        Origin = "exchange.example.invalid · external",
    };

    /// <summary>A tool still executing, used to show the running card treatment.</summary>
    public static ToolItem RunningTest() => new()
    {
        Id = NextId(),
        Kind = ToolKind.Test,
        Name = "shell.exec",
        Target = "uv run pytest tests/harness -q --timeout 120",
        Summary = "collected 214 items · 148 passed so far",
        Outcome = ToolOutcome.Running,
        Duration = TimeSpan.FromSeconds(37),
        Request = "$ uv run pytest tests/harness -q --timeout 120",
        Response = "tests/harness/test_adapter.py ........................              [ 11%]\ntests/harness/test_session.py .............................        [ 24%]\ntests/harness/test_stream.py ......................               [ 35%]\ntests/harness/test_tools.py ...............................       [ 49%]\ntests/harness/test_approval.py ..........",
        ResponseLanguage = "bash",
        Origin = "native host · pty",
        StartExpanded = true,
    };

    /// <summary>
    /// The blocked-decision case. Everything the user needs in order to answer "should this
    /// run?" is on the card; nothing else is.
    /// </summary>
    public static ApprovalItem PendingApproval() => new()
    {
        Id = NextId(),
        Title = "Run a migration against the workspace database",
        Rationale =
            "The adapter change renames `session_authority` to `authority_ref`. Applying it needs one "
            + "schema migration on the workspace Postgres instance. This writes to a shared resource, so it "
            + "needs your decision.",
        Kind = ToolKind.Shell,
        Command = "uv run alembic -c harness/alembic.ini upgrade head\n# 1 revision pending: 8f21c4e_rename_session_authority",
        CommandLanguage = "bash",
        Risk = ApprovalRisk.Elevated,
        Facts = new List<(string, string)>
        {
            ("Target", "postgres · demo-workspace · harness"),
            ("Writes", "2 tables, 1 index"),
            ("Reversible", "Yes — downgrade revision present"),
            ("Blast radius", "Shared workspace, 4 active sessions"),
        },
    };

    /// <summary>A routine approval that has already been answered, for the settled treatment.</summary>
    public static ApprovalItem SettledApproval() => new()
    {
        Id = NextId(),
        Title = "Write files outside the project root",
        Rationale = "Requested access to ~/.example/harness/cache to reuse the downloaded adapter fixtures.",
        Kind = ToolKind.EditFile,
        Command = "write ~/.example/harness/cache/**",
        CommandLanguage = "bash",
        Risk = ApprovalRisk.Routine,
        Facts = new List<(string, string)>
        {
            ("Scope", "~/.example/harness/cache"),
            ("Duration", "This session only"),
        },
        Decision = "Allowed for this session · 13:58",
    };

    private static int _seq = 1000;

    private static string NextId() => "tool-" + (++_seq).ToString(System.Globalization.CultureInfo.InvariantCulture);
}
