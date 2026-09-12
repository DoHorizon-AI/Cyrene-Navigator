// Core/Api/NavigatorApiOptions.cs
//
// Explicit Navigator API connection settings / Navigator API 连接配置。
//
// Every value comes from the process environment. A missing value produces a typed connection
// state the UI can show; the client never invents an endpoint or a credential.

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Api;

public sealed class NavigatorApiOptions
{
    public const string BaseUrlVariable = "CYRENE_NAVIGATOR_API_URL";

    public const string TokenVariable = "CYRENE_NAVIGATOR_API_TOKEN";

    public const string WorkspaceVariable = "CYRENE_NAVIGATOR_WORKSPACE";

    public NavigatorApiOptions(string baseUrl, string bearerToken, string workspaceId)
    {
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            throw new ArgumentException("baseUrl is required", nameof(baseUrl));
        }

        if (string.IsNullOrWhiteSpace(bearerToken))
        {
            throw new ArgumentException("bearerToken is required", nameof(bearerToken));
        }

        if (string.IsNullOrWhiteSpace(workspaceId))
        {
            throw new ArgumentException("workspaceId is required", nameof(workspaceId));
        }

        BaseUrl = baseUrl.TrimEnd('/');
        BearerToken = bearerToken;
        WorkspaceId = workspaceId;
    }

    public string BaseUrl { get; }

    public string BearerToken { get; }

    public string WorkspaceId { get; }

    /// <summary>Path of the workspace-scoped Harness session collection.</summary>
    public string SessionsPath =>
        BaseUrl + "/api/v1/harness/workspaces/" + Uri.EscapeDataString(WorkspaceId) + "/sessions";

    /// <summary>Environment variables that are configured, in stable order.</summary>
    public static IReadOnlyList<string> ConfiguredVariables()
    {
        var configured = new List<string>();
        foreach (var name in new[] { BaseUrlVariable, TokenVariable, WorkspaceVariable })
        {
            if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name)))
            {
                configured.Add(name);
            }
        }

        return configured;
    }

    /// <summary>Names of the environment variables that still need a value.</summary>
    public static IReadOnlyList<string> MissingVariables()
    {
        var missing = new List<string>();
        foreach (var name in new[] { BaseUrlVariable, TokenVariable, WorkspaceVariable })
        {
            if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name)))
            {
                missing.Add(name);
            }
        }

        return missing;
    }

    /// <summary>Reads the environment; returns null and a stable detail when incomplete.</summary>
    public static NavigatorApiOptions? TryFromEnvironment(out string detail)
    {
        var missing = MissingVariables();
        if (missing.Count > 0)
        {
            detail = "Navigator API is not configured. Set " + string.Join(", ", missing) + ".";
            return null;
        }

        detail = string.Empty;
        return new NavigatorApiOptions(
            Environment.GetEnvironmentVariable(BaseUrlVariable)!,
            Environment.GetEnvironmentVariable(TokenVariable)!,
            Environment.GetEnvironmentVariable(WorkspaceVariable)!);
    }
}
