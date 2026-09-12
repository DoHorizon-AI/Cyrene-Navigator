// tools/adaptercheck/Program.cs
//
// Headless API-adapter behaviour check / 无头 API 适配器行为检查。
//
// Drives the real Core/Api sources with scripted HTTP responses and event fixtures, and asserts
// the projections and typed failures the native client depends on. Exit code 0 means every
// check passed.

using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Cyrene.Navigator.Windows.Core;
using Cyrene.Navigator.Windows.Core.Api;

internal static class Program
{
    private static int _checks;
    private static int _failures;

    private static int Main()
    {
        ProjectionChecks();
        SessionListChecks();
        ClientChecks();
        AdapterChecks();

        Console.WriteLine();
        Console.WriteLine(_failures == 0
            ? $"All {_checks} adapter checks passed."
            : $"{_failures} of {_checks} adapter checks FAILED.");
        return _failures == 0 ? 0 : 1;
    }

    // -----------------------------------------------------------------------------------------
    // Event projection
    // -----------------------------------------------------------------------------------------

    private static void ProjectionChecks()
    {
        var events = ParseEvents(CompletedTurnEvents);
        var projection = NavigatorEventProjection.Project(events);

        Check("completed turn projects user, assistant and tool rows", projection.Timeline.Count, 3);
        var user = projection.Timeline[0] as TurnItem;
        Check("user turn text", user?.Markdown, "Persist this exact turn.");
        var assistant = projection.Timeline[1] as TurnItem;
        Check("assistant turn text", assistant?.Markdown, "Done.");
        Check("assistant model label", assistant?.ModelLabel, "mock");
        var tool = projection.Timeline[2] as ToolItem;
        Check("tool call name", tool?.Name, "fs.read");
        Check("tool call kind inferred", tool?.Kind.ToString(), "ReadFile");
        Check("tool outcome settles to ok", tool?.Outcome.ToString(), "Ok");
        Check("tool summary from result", tool?.Summary, "file body");
        Check("tool duration from event times", tool?.Duration.TotalMilliseconds, 1000.0);
        Check("completed turn reaches Done", projection.Run.State.ToString(), "Done");
        Check("no pending approval on a clean turn", projection.PendingApproval is null, true);
        Check("one phase step projected", projection.Run.Steps.Count, 1);
        Check("phase step settles done", projection.Run.Steps[0].State.ToString(), "Done");
        Check("phase step elapsed", projection.Run.Steps[0].Elapsed.TotalMilliseconds, 5000.0);
        Check("tool call becomes the phase child", projection.Run.Steps[0].Children.Count, 1);
        Check("child step elapsed", projection.Run.Steps[0].Children[0].Elapsed.TotalMilliseconds, 1000.0);

        var failed = NavigatorEventProjection.Project(ParseEvents(FailedTurnEvents));
        var failedTool = failed.Timeline[0] as ToolItem;
        Check("failed tool result", failedTool?.Outcome.ToString(), "Failed");
        Check("failed turn state", failed.Run.State.ToString(), "Failed");

        var approval = NavigatorEventProjection.Project(ParseEvents(ApprovalEvents));
        Check("approval event projects a card", approval.Timeline[0].GetType().Name, "ApprovalItem");
        Check("approval becomes pending", approval.PendingApproval is not null, true);
        Check("approval blocks the run", approval.Run.State.ToString(), "AwaitingApproval");

        var cancelled = NavigatorEventProjection.Project(ParseEvents(CancelledTurnEvents));
        Check("cancelled turn state", cancelled.Run.State.ToString(), "Cancelled");
    }

    private static void SessionListChecks()
    {
        var snapshot = new SessionSnapshotRecord
        {
            Meta = JsonDocument.Parse("""{"version":2,"id":"session-a","cwd":"/workspace/project"}""").RootElement,
            EventCount = 12,
            LastActivityAt = DateTimeOffset.Now.AddMinutes(-3).ToUnixTimeMilliseconds(),
        };
        var summary = NavigatorEventProjection.Summarize(snapshot, DateTimeOffset.Now);
        Check("session id from header", summary.Id, "session-a");
        Check("session title from cwd leaf", summary.Title, "project");
        Check("session project", summary.Project, "/workspace/project");
        Check("session activity bucket", summary.Bucket, "Now");
        Check("session preview states committed events", summary.Preview, "12 committed events");
    }

    // -----------------------------------------------------------------------------------------
    // HTTP client
    // -----------------------------------------------------------------------------------------

    private static void ClientChecks()
    {
        var options = new NavigatorApiOptions("http://navigator.test", "test-token", "workspace-a");

        var client = NewClient(options, request =>
        {
            Check("session request path", request.RequestUri!.AbsolutePath,
                "/api/v1/harness/workspaces/workspace-a/sessions");
            Check("bearer credential attached", request.Headers.Authorization?.Parameter, "test-token");
            return Json(HttpStatusCode.OK, """{"items":[{"meta":{"id":"s1","cwd":"/w"},"revision":"r1","eventCount":3}]}""");
        });
        var sessions = client.ListSessions();
        Check("session list item count", sessions.Count, 1);
        Check("session list meta id", sessions[0].Meta.GetProperty("id").GetString(), "s1");

        string? eventsPath = null;
        var eventsClient = NewClient(options, request =>
        {
            eventsPath = request.RequestUri!.AbsolutePath;
            return Json(HttpStatusCode.OK,
                """{"events":[{"seq":0,"time":1,"type":"turn/start","data":{"turn":1}}],"nextSeq":1}""");
        });
        var page = eventsClient.ReadEvents("session/with space");
        Check("events request encodes the session id",
            eventsPath, "/api/v1/harness/workspaces/workspace-a/sessions/session%2Fwith%20space/events");
        Check("event slice parsed", page.Events.Count, 1);
        Check("next cursor parsed", page.NextSeq, 1);

        var problemClient = NewClient(options, _ => Json(HttpStatusCode.NotFound,
            """{"type":"https://errors.cyrene.dev/x","title":"Not found","status":404,"detail":"No such session.","code":"NAVIGATOR_SESSION_UNKNOWN","retryable":false}"""));
        var problem = Catch(() => problemClient.ListSessions());
        Check("problem code kept", problem?.Code, "NAVIGATOR_SESSION_UNKNOWN");
        Check("problem status kept", problem?.Status, 404);
        Check("problem retryable kept", problem?.Retryable, false);
        Check("problem detail kept", problem?.Message, "No such session.");

        var unreachable = Catch(
            () => new NavigatorApiClient(options, new HttpClient(new ThrowingHandler())).ListSessions());
        Check("transport failure is typed", unreachable?.Code, "NAVIGATOR_API_UNREACHABLE");
        Check("transport failure is retryable", unreachable?.Retryable, true);

        var malformed = Catch(
            () => NewClient(options, _ => Json(HttpStatusCode.OK, "not json")).ListSessions());
        Check("malformed payload is typed", malformed?.Code, "NAVIGATOR_API_INVALID_RESPONSE");
    }

    // -----------------------------------------------------------------------------------------
    // Adapters
    // -----------------------------------------------------------------------------------------

    private static void AdapterChecks()
    {
        var options = new NavigatorApiOptions("http://navigator.test", "test-token", "workspace-a");
        var client = NewClient(options, request =>
            request.RequestUri!.AbsolutePath.EndsWith("/events", StringComparison.Ordinal)
                ? Json(HttpStatusCode.OK, EventsEnvelope)
                : Json(HttpStatusCode.OK, """{"items":[{"meta":{"id":"s1","cwd":"/workspace/demo"},"revision":"r1","eventCount":8,"lastActivityAt":""" + DateTimeOffset.Now.ToUnixTimeMilliseconds() + "}]}"));

        var service = new ApiConversationService(client, string.Empty);
        Check("adapter reports connected", service.IsConnected, true);
        Check("adapter reports the connected base url", service.ConnectionDetail.Contains("navigator.test"), true);
        Check("adapter never claims a submit path", service.CanSubmit, false);
        Check("adapter maps the session list", service.Sessions().Count, 1);

        service.OpenSession("s1");
        Check("opening a session projects the timeline", service.Timeline().Count, 2);

        var agent = new ApiAgentState(service);
        Check("agent reads the projected run", agent.Run.State.ToString(), "Done");
        Check("agent has no pending approval", agent.PendingApproval(agent.Run.Id) is null, true);
        Check("agent reports no background runs", agent.BackgroundRuns().Count, 0);
        var stop = Catch(() =>
        {
            agent.Stop();
            return null;
        });
        Check("cancel is a typed not-connected error", stop?.Code, "NAVIGATOR_CONTROL_NOT_CONNECTED");
        var decide = Catch(() =>
        {
            agent.Decide(agent.Run.Id, "allow");
            return null;
        });
        Check("approval decision is a typed not-connected error", decide?.Code, "NAVIGATOR_CONTROL_NOT_CONNECTED");

        var uiData = new ApiUiData(service);
        Check("ui data reports no model catalogue", uiData.Models.Count, 0);
        Check("ui data reports no metrics", uiData.Metrics.Count, 0);
        Check("ui data reports no resource sections", uiData.ResourceSections.Count, 0);
        Check("ui data usage is unreported", uiData.SessionUsage.Reported, false);

        var unconfigured = new ApiConversationService(null, "Navigator API is not configured. Set X.");
        Check("unconfigured adapter reports disconnected", unconfigured.IsConnected, false);
        Check("unconfigured adapter keeps the detail", unconfigured.ConnectionDetail,
            "Navigator API is not configured. Set X.");
    }

    // -----------------------------------------------------------------------------------------
    // Scripted HTTP plumbing
    // -----------------------------------------------------------------------------------------

    private sealed class ScriptedHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;

        public ScriptedHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
        {
            _responder = responder;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            _ = cancellationToken;
            return Task.FromResult(_responder(request));
        }

        /// <summary>The client uses the synchronous HTTP path; the double answers it directly.</summary>
        protected override HttpResponseMessage Send(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            _ = cancellationToken;
            return _responder(request);
        }
    }

    private sealed class ThrowingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            _ = request;
            _ = cancellationToken;
            throw new HttpRequestException("connection refused");
        }

        protected override HttpResponseMessage Send(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            _ = request;
            _ = cancellationToken;
            throw new HttpRequestException("connection refused");
        }
    }

    private static NavigatorApiClient NewClient(
        NavigatorApiOptions options, Func<HttpRequestMessage, HttpResponseMessage> responder) =>
        new(options, new HttpClient(new ScriptedHandler(responder)));

    private static HttpResponseMessage Json(HttpStatusCode status, string body) =>
        new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };

    private static List<SessionEventRecord> ParseEvents(string json) =>
        JsonSerializer.Deserialize<List<SessionEventRecord>>(
            json,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;

    private static NavigatorApiError? Catch(Func<object?> action)
    {
        try
        {
            _ = action();
            return null;
        }
        catch (NavigatorApiError error)
        {
            return error;
        }
    }

    private static void Check<T>(string name, T actual, T expected)
    {
        _checks++;
        if (EqualityComparer<T>.Default.Equals(actual, expected))
        {
            return;
        }

        _failures++;
        Console.WriteLine($"FAIL {name}: expected <{expected}>, got <{actual}>");
    }

    // -----------------------------------------------------------------------------------------
    // Fixtures mirroring the upstream Harness event shapes used by the persistence tests.
    // -----------------------------------------------------------------------------------------

    private const string CompletedTurnEvents = """
    [
      {"seq":0,"time":1000,"type":"turn/start","data":{"turn":1}},
      {"seq":1,"time":2000,"type":"step/start","data":{"turn":1,"step":1}},
      {"seq":2,"time":3000,"type":"user/message","data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Persist this exact turn."}]}},
      {"seq":3,"time":4000,"type":"assistant/message","data":{"turn":1,"step":1,"stream":[],"message":{"source":{"kind":"model","provider":"mock","model":"mock"},"content":[{"type":"text","text":"Done."}]}}},
      {"seq":4,"time":5000,"type":"tool/call","data":{"turn":1,"step":1,"callId":"call-1","name":"fs.read","arguments":"{\"path\":\"a.txt\"}"}},
      {"seq":5,"time":6000,"type":"tool/result","data":{"turn":1,"step":1,"message":{"callId":"call-1","content":[{"type":"text","text":"file body"}],"isError":false}}},
      {"seq":6,"time":7000,"type":"step/end","data":{"turn":1,"step":1}},
      {"seq":7,"time":8000,"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}
    ]
    """;

    private const string FailedTurnEvents = """
    [
      {"seq":0,"time":1000,"type":"turn/start","data":{"turn":1}},
      {"seq":1,"time":2000,"type":"tool/call","data":{"turn":1,"step":1,"callId":"call-9","name":"shell.exec","arguments":"make"}},
      {"seq":2,"time":3000,"type":"tool/result","data":{"turn":1,"step":1,"message":{"callId":"call-9","content":[{"type":"text","text":"exit 1"}],"isError":true}}},
      {"seq":3,"time":4000,"type":"turn/end","data":{"turn":1,"reason":{"kind":"failed"}}}
    ]
    """;

    private const string ApprovalEvents = """
    [
      {"seq":0,"time":1000,"type":"turn/start","data":{"turn":1}},
      {"seq":1,"time":2000,"type":"approval/request","data":{"title":"Allow the migration?","detail":"Writes to a shared resource.","command":"alembic upgrade head","decision":null}}
    ]
    """;

    private const string CancelledTurnEvents = """
    [
      {"seq":0,"time":1000,"type":"turn/start","data":{"turn":1}},
      {"seq":1,"time":2000,"type":"turn/end","data":{"turn":1,"reason":{"kind":"cancelled"}}}
    ]
    """;

    private const string EventsEnvelope = """
    {"events":
    [
      {"seq":0,"time":1000,"type":"turn/start","data":{"turn":1}},
      {"seq":1,"time":2000,"type":"user/message","data":{"source":{"kind":"user"},"content":[{"type":"text","text":"Hi"}]}},
      {"seq":2,"time":3000,"type":"assistant/message","data":{"turn":1,"step":1,"message":{"source":{"kind":"model","model":"mock"},"content":[{"type":"text","text":"Hello"}]}}},
      {"seq":3,"time":4000,"type":"turn/end","data":{"turn":1,"reason":{"kind":"completed"}}}
    ],"nextSeq":4}
    """;
}
