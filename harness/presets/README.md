# Navigator agent presets / Navigator Agent 预设

The default preset reuses upstream tools with a bounded starting catalog for
text models. The upstream standard presets remain available for users who need
their larger coding/delegation catalog and have a suitable model context window.

默认预设复用成熟上游工具，控制首次请求的工具目录大小，适合普通文本模型。
需要完整编程或多 Agent 工具的用户仍可选择上游预设及足够上下文的模型。

Skill discovery uses the Navigator Harness home's `skills` directory. It does
not automatically ingest another agent product's global skills. Users can add
explicit skill roots through their own preset composition.

Skill 从 Navigator 的 Harness home 下 `skills` 目录读取；其它客户端的全局技能不会
自动塞入新会话。用户可在自己的预设中显式添加目录。通用 Skill/Workflow 执行仍由
上游插件提供。
