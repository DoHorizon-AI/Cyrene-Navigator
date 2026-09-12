// Core/Api/NavigatorApiDtos.cs
//
// Navigator API wire records / Navigator API 线格式记录。
//
// Field names match the published persistence contract (camelCase). Opaque Harness content
// (meta, event data) stays as JsonElement: the client projects what it understands and never
// rewrites what it does not.

using System.Collections.Generic;
using System.Text.Json;

namespace Cyrene.Navigator.Windows.Core.Api;

public sealed class ProductMetadataRecord
{
    public string WorkspaceId { get; init; } = string.Empty;

    public string SessionId { get; init; } = string.Empty;

    public string? CreatorActorId { get; init; }

    public string? OwnerActorId { get; init; }

    public string OwnerState { get; init; } = "unknown";

    public int MetadataVersion { get; init; }

    public string Source { get; init; } = "cyrene";
}

public sealed class SessionSnapshotRecord
{
    /// <summary>Opaque Harness session header; the client reads id/cwd and ignores the rest.</summary>
    public JsonElement Meta { get; init; }

    public ProductMetadataRecord? ProductMetadata { get; init; }

    public string Revision { get; init; } = string.Empty;

    public int EventCount { get; init; }

    public long? LastActivityAt { get; init; }
}

public sealed class SessionListRecord
{
    public IReadOnlyList<SessionSnapshotRecord> Items { get; init; } = new List<SessionSnapshotRecord>();
}

public sealed class SessionEventRecord
{
    public int Seq { get; init; }

    /// <summary>Harness event time as milliseconds since the Unix epoch.</summary>
    public long Time { get; init; }

    public string Type { get; init; } = string.Empty;

    public JsonElement Data { get; init; }

    public string? SurfaceOp { get; init; }
}

public sealed class EventPageRecord
{
    public IReadOnlyList<SessionEventRecord> Events { get; init; } = new List<SessionEventRecord>();

    public int NextSeq { get; init; }
}
