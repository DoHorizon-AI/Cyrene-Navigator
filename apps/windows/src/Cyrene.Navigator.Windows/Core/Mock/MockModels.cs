// Core/Mock/MockModels.cs
//
// Mock model catalogue / 模型目录（mock）。
//
// The catalogue is intentionally small and grouped by *where the model runs* rather than by
// vendor. Navigator's differentiator is that hosted APIs, workspace GPU pools and on-device
// models are the same kind of thing to the user, so the UI groups them by locality.
//
// 分组按"在哪里跑"而不是按厂商 —— 这是 Navigator 与常见客户端最大的信息架构差异。

using System.Collections.Generic;

namespace Cyrene.Navigator.Windows.Core.Mock;

public static class MockModels
{
    public static IReadOnlyList<ModelDescriptor> All { get; } = new List<ModelDescriptor>
    {
        new()
        {
            Id = "example-chat",
            Name = "Example Chat",
            Provider = "Example Hosted",
            Tier = ModelTier.Hosted,
            ContextLabel = "200K",
            CostLabel = "$15 / $75 per Mtok",
            Tagline = "Long-horizon agent work",
            Vision = true,
            Tools = true,
            Thinking = true,
        },
        new()
        {
            Id = "example-reasoner",
            Name = "Example Reasoner",
            Provider = "Example Hosted",
            Tier = ModelTier.Hosted,
            ContextLabel = "400K",
            CostLabel = "$5 / $40 per Mtok",
            Tagline = "Balanced default",
            Vision = true,
            Tools = true,
            Thinking = true,
        },
        new()
        {
            Id = "example-analyst",
            Name = "Example Analyst",
            Provider = "Example Hosted",
            Tier = ModelTier.Hosted,
            ContextLabel = "2M",
            CostLabel = "$3 / $18 per Mtok",
            Tagline = "Whole-repository context",
            Vision = true,
            Tools = true,
            Thinking = false,
        },
        new()
        {
            Id = "example-coder",
            Name = "Example Coder",
            Provider = "Example Hosted",
            Tier = ModelTier.Hosted,
            ContextLabel = "128K",
            CostLabel = "$0.4 / $1.6 per Mtok",
            Tagline = "Cheap, strong at code",
            Vision = false,
            Tools = true,
            Thinking = true,
        },
        new()
        {
            Id = "example-multimodal-27b",
            Name = "Example Multimodal",
            Provider = "Demo GPU Pool",
            Tier = ModelTier.Workspace,
            ContextLabel = "128K",
            CostLabel = "demo pool",
            Tagline = "27B multimodal, in-house",
            Vision = true,
            Tools = true,
            Thinking = false,
        },
        new()
        {
            Id = "example-local-32b",
            Name = "Example Local 32B",
            Provider = "Demo GPU Pool",
            Tier = ModelTier.Workspace,
            ContextLabel = "64K",
            CostLabel = "demo pool",
            Tagline = "Bulk classification and eval",
            Vision = false,
            Tools = true,
            Thinking = false,
        },
        new()
        {
            Id = "example-local-8b",
            Name = "Example Local 8B",
            Provider = "This device · native host",
            Tier = ModelTier.Local,
            ContextLabel = "32K",
            CostLabel = "free · offline",
            Tagline = "Offline drafts and redaction",
            Vision = false,
            Tools = false,
            Thinking = false,
        },
        new()
        {
            Id = "example-mini-local",
            Name = "Example Mini",
            Provider = "This device · local accelerator",
            Tier = ModelTier.Local,
            ContextLabel = "16K",
            CostLabel = "free · offline",
            Tagline = "Instant local completions",
            Vision = false,
            Tools = false,
            Thinking = false,
            Unavailable = "NPU runtime not installed",
        },
    };

    public static ModelDescriptor Default => All[0];

    public static ModelDescriptor ById(string id)
    {
        foreach (var model in All)
        {
            if (model.Id == id)
            {
                return model;
            }
        }

        return Default;
    }
}
