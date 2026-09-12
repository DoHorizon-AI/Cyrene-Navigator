// Core/Api/NavigatorApiError.cs
//
// Typed Navigator API failure / 类型化 Navigator API 失败。
//
// RFC 9457 problem responses, transport failures, and malformed payloads all surface as this
// one type so views can render a stable code instead of a transport exception.

using System;
using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Api;

public sealed class NavigatorApiError : Exception
{
    public NavigatorApiError(string code, string detail, int status, bool retryable, Exception? inner = null)
        : base(detail, inner)
    {
        Code = code;
        Status = status;
        Retryable = retryable;
    }

    /// <summary>Stable machine-readable code; problem responses keep the owner's code.</summary>
    public string Code { get; }

    /// <summary>HTTP status, or 0 when no response arrived.</summary>
    public int Status { get; }

    public bool Retryable { get; }

    public static NavigatorApiError NotConfigured(IReadOnlyList<string> missing) =>
        new(
            "NAVIGATOR_API_NOT_CONFIGURED",
            "Navigator API is not configured. Set " + string.Join(", ", missing) + ".",
            0,
            retryable: false);

    public static NavigatorApiError Unreachable(string detail, Exception? inner = null) =>
        new("NAVIGATOR_API_UNREACHABLE", detail, 0, retryable: true, inner);

    public static NavigatorApiError FromProblem(string? code, string? detail, int status, bool retryable) =>
        new(
            string.IsNullOrWhiteSpace(code) ? "NAVIGATOR_API_PROBLEM" : code!,
            string.IsNullOrWhiteSpace(detail) ? "The Navigator API rejected the request." : detail!,
            status,
            retryable);

    public static NavigatorApiError InvalidResponse(string detail, Exception? inner = null) =>
        new("NAVIGATOR_API_INVALID_RESPONSE", detail, 0, retryable: false, inner);

    public static NavigatorApiError NotConnected(string action, string detail) =>
        new("NAVIGATOR_CONTROL_NOT_CONNECTED", action + " is not connected: " + detail, 0, retryable: false);
}
