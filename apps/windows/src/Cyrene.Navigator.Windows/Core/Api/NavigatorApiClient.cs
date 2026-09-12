// Core/Api/NavigatorApiClient.cs
//
// Real Navigator HTTP client / 真实 Navigator HTTP 客户端。
//
// This is the only transport in the native client. It speaks the published persistence and
// aggregation contracts with a bearer credential, applies a finite timeout, and converts every
// failure into NavigatorApiError so callers never see a raw transport exception.

using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Cyrene.Navigator.Windows.Core.Api;

public sealed class NavigatorApiClient : IDisposable
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _client;
    private readonly bool _ownsClient;
    private readonly NavigatorApiOptions _options;

    public NavigatorApiClient(NavigatorApiOptions options, HttpClient? client = null)
    {
        _options = options;
        if (client is null)
        {
            _client = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            _ownsClient = true;
        }
        else
        {
            _client = client;
        }
    }

    public NavigatorApiOptions Options => _options;

    /// <summary>Workspace-scoped session list. | 工作区会话列表。 </summary>
    public IReadOnlyList<SessionSnapshotRecord> ListSessions()
    {
        var payload = SendJson(HttpMethod.Get, _options.SessionsPath, null);
        var list = Deserialize<SessionListRecord>(payload, "session list");
        return list.Items;
    }

    /// <summary>One committed slice of a session event log. | 会话事件片段。 </summary>
    public EventPageRecord ReadEvents(string sessionId, int offset = 0, int length = 10_000)
    {
        var url = _options.SessionsPath
            + "/" + Uri.EscapeDataString(sessionId)
            + "/events?offset=" + offset.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + "&length=" + length.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var payload = SendJson(HttpMethod.Get, url, null);
        return Deserialize<EventPageRecord>(payload, "session events");
    }

    public void Dispose()
    {
        if (_ownsClient)
        {
            _client.Dispose();
        }
    }

    // -----------------------------------------------------------------------------------------

    private string SendJson(HttpMethod method, string url, string? jsonBody)
    {
        using var request = new HttpRequestMessage(method, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _options.BearerToken);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (jsonBody is not null)
        {
            request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        }

        HttpResponseMessage response;
        try
        {
            response = _client.Send(request);
        }
        catch (HttpRequestException exception)
        {
            throw NavigatorApiError.Unreachable(
                "Navigator API is unreachable at " + _options.BaseUrl + ".", exception);
        }
        catch (TaskCanceledException exception)
        {
            throw NavigatorApiError.Unreachable(
                "Navigator API did not answer within the client timeout.", exception);
        }

        using (response)
        {
            var content = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            if (!response.IsSuccessStatusCode)
            {
                throw ProblemFrom(response.StatusCode, content);
            }

            return content;
        }
    }

    private static T Deserialize<T>(string payload, string what)
        where T : class
    {
        try
        {
            var value = JsonSerializer.Deserialize<T>(payload, Json);
            if (value is null)
            {
                throw NavigatorApiError.InvalidResponse("The " + what + " response was empty.");
            }

            return value;
        }
        catch (JsonException exception)
        {
            throw NavigatorApiError.InvalidResponse(
                "The " + what + " response was not valid JSON.", exception);
        }
    }

    private static NavigatorApiError ProblemFrom(System.Net.HttpStatusCode status, string content)
    {
        string? code = null;
        string? detail = null;
        var retryable = (int)status >= 500;
        try
        {
            using var document = JsonDocument.Parse(content);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Object)
            {
                code = ReadString(root, "code");
                detail = ReadString(root, "detail");
                if (root.TryGetProperty("retryable", out var flag)
                    && (flag.ValueKind == JsonValueKind.True || flag.ValueKind == JsonValueKind.False))
                {
                    retryable = flag.GetBoolean();
                }
            }
        }
        catch (JsonException)
        {
            // A non-JSON body keeps the status-derived defaults.
        }

        return NavigatorApiError.FromProblem(code, detail, (int)status, retryable);
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
