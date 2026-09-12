//! ┌─────────────────────────────────────────────────────────────────────┐
//! │  📄 codex.rs                                                         │
//! │  Module: cyrene_native_host::codex                                    │
//! │  Role: Import real Codex rollout JSONL as auditable conversation data.│
//! │                                                                      │
//! │  模块职责：将真实 Codex rollout JSONL 导入为可审计会话数据。           │
//! └─────────────────────────────────────────────────────────────────────┘

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::process::CancellationToken;
use crate::protocol::ProtocolError;

/// Upper bound for a rollout file read by the bridge.
pub const MAX_ROLLOUT_BYTES: u64 = 256 * 1024 * 1024;

/// Upper bound for including raw text directly in one protocol response.
pub const MAX_INLINE_RAW_BYTES: u64 = 8 * 1024 * 1024;

const MAX_REPORT_ENTRIES: usize = 256;
/// Event messages are a UI-side projection of nearby response items. A small
/// line window pairs that mirror without suppressing a later repeated turn.
const MESSAGE_MIRROR_WINDOW_LINES: usize = 16;
const CODEX_IMPORT_SCHEMA: &str = "cyrene.navigator.codex-import.v1";

/// Import one real Codex rollout JSONL file.
///
/// The importer keeps the source digest and a retrievable local-file reference.
/// It projects only ordinary conversation messages into the normalized message
/// list. Tool calls, tool results, system records, reasoning, and unknown items
/// remain historical events and are explicitly non-executable.
pub fn import_rollout(params: &Value, token: &CancellationToken) -> Result<Value, ProtocolError> {
    let object = params.as_object().ok_or_else(|| {
        ProtocolError::new("invalid_params", "Codex import params must be an object")
    })?;
    reject_unknown_fields(object, &["path", "include_raw", "max_bytes"])?;

    let input = object
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ProtocolError::new("invalid_params", "Codex rollout path is required"))?;
    if input.is_empty() || input.len() > 4096 || input.chars().any(|c| c.is_control()) {
        return Err(ProtocolError::new(
            "invalid_params",
            "Codex rollout path must be a non-empty path of at most 4096 bytes",
        ));
    }
    let path = PathBuf::from(input);
    let metadata = fs::metadata(&path).map_err(|_| {
        ProtocolError::new(
            "input_not_found",
            "the Codex rollout path does not exist or is not readable",
        )
    })?;
    if !metadata.is_file() {
        return Err(ProtocolError::new(
            "invalid_params",
            "Codex rollout path must refer to a regular file",
        ));
    }

    let max_bytes = object
        .get("max_bytes")
        .map(|value| {
            value.as_u64().ok_or_else(|| {
                ProtocolError::new("invalid_params", "max_bytes must be an unsigned integer")
            })
        })
        .transpose()?
        .unwrap_or(MAX_ROLLOUT_BYTES);
    if max_bytes == 0 || max_bytes > MAX_ROLLOUT_BYTES {
        return Err(ProtocolError::new(
            "invalid_params",
            format!("max_bytes must be between 1 and {MAX_ROLLOUT_BYTES}"),
        ));
    }
    if metadata.len() > max_bytes {
        return Err(ProtocolError::new(
            "input_too_large",
            format!("Codex rollout exceeds the {max_bytes} byte limit"),
        ));
    }

    let include_raw = object
        .get("include_raw")
        .map(|value| {
            value.as_bool().ok_or_else(|| {
                ProtocolError::new("invalid_params", "include_raw must be a boolean")
            })
        })
        .transpose()?
        .unwrap_or(false);
    if include_raw && metadata.len() > MAX_INLINE_RAW_BYTES {
        return Err(ProtocolError::new(
            "input_too_large",
            format!(
                "include_raw is limited to {MAX_INLINE_RAW_BYTES} bytes; use the raw reference for larger files"
            ),
        ));
    }

    let raw = read_file_bounded(&path, max_bytes, token)?;
    let source_sha256 = format!("sha256:{}", hex::encode(Sha256::digest(&raw)));
    let text = String::from_utf8(raw.clone())
        .map_err(|_| ProtocolError::new("invalid_encoding", "Codex rollout must be UTF-8 JSONL"))?;
    let raw_reference = canonical_reference(&path);

    let imported = parse_rollout(
        &text,
        &source_sha256,
        raw.len() as u64,
        raw_reference,
        include_raw.then_some(text.clone()),
        token,
    )?;
    Ok(imported)
}

#[derive(Debug, Default, Serialize)]
struct ConversionReport {
    schema_version: u32,
    records_total: usize,
    records_recognized: usize,
    message_records: usize,
    tool_call_records: usize,
    tool_result_records: usize,
    metadata_records: usize,
    unknown_records: usize,
    malformed_records: usize,
    duplicate_records: usize,
    warnings: Vec<Warning>,
}

#[derive(Debug, Serialize)]
struct Warning {
    code: String,
    message: String,
    line: Option<usize>,
    record_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct SessionSummary {
    session_id: Option<String>,
    title: Option<String>,
    created_at: Option<String>,
    cwd: Option<String>,
    originator: Option<String>,
    cli_version: Option<String>,
    model_provider: Option<String>,
}

#[derive(Debug, Serialize)]
struct RawReference {
    kind: &'static str,
    path: String,
}

#[derive(Debug, Serialize)]
struct RawArchive {
    sha256: String,
    size_bytes: u64,
    encoding: &'static str,
    reference: RawReference,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
}

fn parse_rollout(
    text: &str,
    source_sha256: &str,
    source_size_bytes: u64,
    raw_path: String,
    raw_content: Option<String>,
    token: &CancellationToken,
) -> Result<Value, ProtocolError> {
    let mut report = ConversionReport {
        schema_version: 1,
        ..ConversionReport::default()
    };
    let mut session = SessionSummary {
        session_id: None,
        title: None,
        created_at: None,
        cwd: None,
        originator: None,
        cli_version: None,
        model_provider: None,
    };
    let mut messages = Vec::new();
    let mut events = Vec::new();
    let mut unknown_records = Vec::new();
    let mut seen_source_ids = HashSet::new();
    let mut message_mirrors = MessageMirrorState::default();

    for (line_index, line) in text.lines().enumerate() {
        if token.is_cancelled() {
            return Err(ProtocolError::new(
                "cancelled",
                "Codex rollout import was cancelled",
            ));
        }
        let line_number = line_index + 1;
        if line.trim().is_empty() {
            continue;
        }
        report.records_total += 1;
        let record: Value = match serde_json::from_str(line) {
            Ok(record) => record,
            Err(error) => {
                report.malformed_records += 1;
                push_warning(
                    &mut report,
                    Warning {
                        code: "malformed_json_line".to_string(),
                        message: format!("line {line_number} is not valid JSON: {error}"),
                        line: Some(line_number),
                        record_type: None,
                    },
                );
                continue;
            }
        };
        let Some(object) = record.as_object() else {
            report.unknown_records += 1;
            push_unknown(
                &mut unknown_records,
                &mut report,
                line_number,
                None,
                "rollout record must be a JSON object",
            );
            continue;
        };
        let Some(record_type) = object.get("type").and_then(Value::as_str) else {
            report.unknown_records += 1;
            push_unknown(
                &mut unknown_records,
                &mut report,
                line_number,
                None,
                "rollout record has no type field",
            );
            continue;
        };
        let timestamp = string_value(object.get("timestamp"));

        match record_type {
            "session_meta" => {
                report.records_recognized += 1;
                report.metadata_records += 1;
                parse_session_meta(
                    object.get("payload"),
                    &mut session,
                    &mut report,
                    line_number,
                );
            }
            "response_item" => {
                report.records_recognized += 1;
                parse_response_item(
                    object.get("payload"),
                    timestamp.as_deref(),
                    line_number,
                    source_sha256,
                    &mut messages,
                    &mut events,
                    &mut report,
                    &mut unknown_records,
                    &mut seen_source_ids,
                    &mut message_mirrors,
                );
            }
            "event_msg" => {
                report.records_recognized += 1;
                parse_event_msg(
                    object.get("payload"),
                    timestamp.as_deref(),
                    line_number,
                    source_sha256,
                    &mut messages,
                    &mut events,
                    &mut report,
                    &mut seen_source_ids,
                    &mut message_mirrors,
                );
            }
            "turn_context" => {
                report.records_recognized += 1;
                report.metadata_records += 1;
                parse_turn_context(object.get("payload"), &mut session);
                events.push(json!({
                    "kind": "historical_record",
                    "record_type": record_type,
                    "line": line_number,
                    "timestamp": timestamp,
                    "executable": false,
                }));
            }
            "compacted"
            | "token_usage_record"
            | "world_state"
            | "retained_context"
            | "security_risk_score"
            | "inter_agent_communication"
            | "inter_agent_communication_metadata"
            | "realtime_item" => {
                report.records_recognized += 1;
                report.metadata_records += 1;
                events.push(json!({
                    "kind": "historical_record",
                    "record_type": record_type,
                    "line": line_number,
                    "timestamp": timestamp,
                    "payload_sha256": value_digest(object.get("payload").unwrap_or(&Value::Null)),
                    "executable": false,
                }));
            }
            _ => {
                report.unknown_records += 1;
                push_unknown(
                    &mut unknown_records,
                    &mut report,
                    line_number,
                    Some(record_type),
                    "record type is not recognized by this importer; source remains in raw archive",
                );
                push_warning(
                    &mut report,
                    Warning {
                        code: "unknown_record_type".to_string(),
                        message: "unknown record type was retained only in the raw archive"
                            .to_string(),
                        line: Some(line_number),
                        record_type: Some(record_type.to_string()),
                    },
                );
            }
        }
    }

    if report.records_total == 0 {
        return Err(ProtocolError::new(
            "invalid_rollout",
            "Codex rollout JSONL is empty",
        ));
    }
    if report.records_recognized == 0 {
        return Err(ProtocolError::new(
            "invalid_rollout",
            "no recognized Codex rollout records were found",
        )
        .with_data(json!({
            "records_total": report.records_total,
            "unknown_records": report.unknown_records,
            "malformed_records": report.malformed_records,
        })));
    }
    let raw = RawArchive {
        sha256: source_sha256.to_string(),
        size_bytes: source_size_bytes,
        encoding: "utf-8",
        reference: RawReference {
            kind: "filesystem",
            path: raw_path,
        },
        content: raw_content,
    };

    Ok(json!({
        "schema": CODEX_IMPORT_SCHEMA,
        "source": "codex",
        "source_sha256": source_sha256,
        "source_size_bytes": source_size_bytes,
        "session": session,
        "messages": messages,
        "events": events,
        "unknown_records": unknown_records,
        "raw": raw,
        "conversion_report": report,
        "safety": {
            "historical_tool_calls_executable": false,
            "historical_system_content_live": false,
            "history_replayed": false,
        },
    }))
}

fn parse_session_meta(
    payload: Option<&Value>,
    session: &mut SessionSummary,
    report: &mut ConversionReport,
    line: usize,
) {
    let Some(payload) = payload else {
        push_warning(
            report,
            Warning {
                code: "missing_payload".to_string(),
                message: "session_meta record has no payload".to_string(),
                line: Some(line),
                record_type: Some("session_meta".to_string()),
            },
        );
        return;
    };
    let source = payload.get("meta").unwrap_or(payload);
    session.session_id = session
        .session_id
        .take()
        .or_else(|| first_string(source, &["session_id", "id"]));
    session.title = session
        .title
        .take()
        .or_else(|| first_string(source, &["title", "thread_name"]));
    session.created_at = session
        .created_at
        .take()
        .or_else(|| first_string(source, &["timestamp", "created_at"]));
    session.cwd = session
        .cwd
        .take()
        .or_else(|| first_string(source, &["cwd"]));
    session.originator = session
        .originator
        .take()
        .or_else(|| first_string(source, &["originator"]));
    session.cli_version = session
        .cli_version
        .take()
        .or_else(|| first_string(source, &["cli_version"]));
    session.model_provider = session
        .model_provider
        .take()
        .or_else(|| first_string(source, &["model_provider"]));
}

fn parse_turn_context(payload: Option<&Value>, session: &mut SessionSummary) {
    let Some(payload) = payload.and_then(Value::as_object) else {
        return;
    };
    session.cwd = session
        .cwd
        .take()
        .or_else(|| first_string_map(payload, &["cwd"]));
    session.model_provider = session
        .model_provider
        .take()
        .or_else(|| first_string_map(payload, &["model_provider", "provider"]));
}

#[allow(clippy::too_many_arguments)]
fn parse_response_item(
    payload: Option<&Value>,
    timestamp: Option<&str>,
    line: usize,
    source_sha256: &str,
    messages: &mut Vec<Value>,
    events: &mut Vec<Value>,
    report: &mut ConversionReport,
    unknown_records: &mut Vec<Value>,
    seen_source_ids: &mut HashSet<String>,
    message_mirrors: &mut MessageMirrorState,
) {
    let Some(payload) = payload.and_then(Value::as_object) else {
        report.unknown_records += 1;
        push_unknown(
            unknown_records,
            report,
            line,
            Some("response_item"),
            "response_item payload must be an object",
        );
        return;
    };
    let item_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match item_type {
        "message" => {
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let text = extract_content_text(payload.get("content"));
            let source_id = first_string_map(payload, &["id"]);
            if role == "user" || role == "assistant" {
                report.message_records += 1;
                add_message(
                    role,
                    &text,
                    source_id.as_deref(),
                    timestamp,
                    payload.get("model").and_then(Value::as_str),
                    line,
                    source_sha256,
                    messages,
                    events,
                    report,
                    seen_source_ids,
                    message_mirrors,
                    MessageOrigin::ResponseItem,
                );
            } else {
                report.metadata_records += 1;
                events.push(json!({
                    "kind": "historical_message",
                    "role": role,
                    "text": text,
                    "source_id": source_id,
                    "line": line,
                    "timestamp": timestamp,
                    "executable": false,
                }));
                push_warning(
                    report,
                    Warning {
                        code: "untrusted_message_role".to_string(),
                        message: "non-user/assistant message remains historical data".to_string(),
                        line: Some(line),
                        record_type: Some(item_type.to_string()),
                    },
                );
            }
        }
        "function_call" | "custom_tool_call" | "local_shell_call" | "mcp_tool_call" => {
            report.tool_call_records += 1;
            let call_id = first_string_map(payload, &["call_id", "id"])
                .unwrap_or_else(|| format!("line-{line}"));
            let name = first_string_map(payload, &["name", "tool"])
                .or_else(|| (item_type == "local_shell_call").then(|| "local_shell".to_string()))
                .unwrap_or_else(|| item_type.to_string());
            let arguments = payload
                .get("arguments")
                .or_else(|| payload.get("input"))
                .or_else(|| payload.get("action"))
                .unwrap_or(&Value::Null);
            events.push(json!({
                "kind": "historical_tool_call",
                "call_id": call_id,
                "name": name,
                "arguments_sha256": value_digest(arguments),
                "line": line,
                "timestamp": timestamp,
                "executable": false,
            }));
            push_warning_once(
                report,
                "historical_tool_calls_not_executable",
                "historical tool calls were imported as data and will not be dispatched",
            );
        }
        "function_call_output" | "custom_tool_call_output" | "mcp_tool_call_output" => {
            report.tool_result_records += 1;
            let call_id = first_string_map(payload, &["call_id", "id"])
                .unwrap_or_else(|| format!("line-{line}"));
            let output = payload.get("output").unwrap_or(&Value::Null);
            let is_error = payload
                .get("is_error")
                .and_then(Value::as_bool)
                .or_else(|| payload.get("isError").and_then(Value::as_bool))
                .unwrap_or(false);
            events.push(json!({
                "kind": "historical_tool_result",
                "call_id": call_id,
                "output_sha256": value_digest(output),
                "is_error": is_error,
                "line": line,
                "timestamp": timestamp,
                "executable": false,
            }));
            push_warning_once(
                report,
                "historical_tool_results_not_executable",
                "historical tool results were imported as data and will not be replayed",
            );
        }
        "agent_message" => {
            report.message_records += 1;
            let role = payload
                .get("author")
                .and_then(Value::as_str)
                .unwrap_or("assistant");
            let text = extract_content_text(payload.get("content"));
            add_message(
                if role == "user" { "user" } else { "assistant" },
                &text,
                first_string_map(payload, &["id"]).as_deref(),
                timestamp,
                None,
                line,
                source_sha256,
                messages,
                events,
                report,
                seen_source_ids,
                message_mirrors,
                MessageOrigin::ResponseItem,
            );
        }
        _ => {
            report.unknown_records += 1;
            push_unknown(
                unknown_records,
                report,
                line,
                Some(item_type),
                "response item type is not projected; source remains in raw archive",
            );
            events.push(json!({
                "kind": "historical_record",
                "record_type": format!("response_item/{item_type}"),
                "line": line,
                "timestamp": timestamp,
                "payload_sha256": value_digest(&Value::Object(payload.clone())),
                "executable": false,
            }));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn parse_event_msg(
    payload: Option<&Value>,
    timestamp: Option<&str>,
    line: usize,
    source_sha256: &str,
    messages: &mut Vec<Value>,
    events: &mut Vec<Value>,
    report: &mut ConversionReport,
    seen_source_ids: &mut HashSet<String>,
    message_mirrors: &mut MessageMirrorState,
) {
    let Some(payload) = payload.and_then(Value::as_object) else {
        report.unknown_records += 1;
        push_warning_once(
            report,
            "event_without_payload",
            "event_msg without an object payload was retained only in raw archive",
        );
        return;
    };
    let event_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    match event_type {
        "user_message" => {
            let text = first_string_map(payload, &["message", "text"]).unwrap_or_default();
            if !text.is_empty() {
                report.message_records += 1;
                add_message(
                    "user",
                    &text,
                    first_string_map(payload, &["id"]).as_deref(),
                    timestamp,
                    None,
                    line,
                    source_sha256,
                    messages,
                    events,
                    report,
                    seen_source_ids,
                    message_mirrors,
                    MessageOrigin::EventFallback,
                );
            }
        }
        "agent_message" | "assistant_message" => {
            let text = first_string_map(payload, &["message", "text"]).unwrap_or_default();
            if !text.is_empty() {
                report.message_records += 1;
                add_message(
                    "assistant",
                    &text,
                    first_string_map(payload, &["id"]).as_deref(),
                    timestamp,
                    None,
                    line,
                    source_sha256,
                    messages,
                    events,
                    report,
                    seen_source_ids,
                    message_mirrors,
                    MessageOrigin::EventFallback,
                );
            }
        }
        "mcp_tool_call_begin" | "mcp_tool_call_end" | "tool_call" | "tool_result" => {
            report.metadata_records += 1;
            events.push(json!({
                "kind": "historical_tool_event",
                "event_type": event_type,
                "call_id": first_string_map(payload, &["call_id", "id"]),
                "line": line,
                "timestamp": timestamp,
                "payload_sha256": value_digest(&Value::Object(payload.clone())),
                "executable": false,
            }));
            push_warning_once(
                report,
                "historical_tool_events_not_executable",
                "historical tool lifecycle events were imported as data and will not be replayed",
            );
        }
        _ => {
            report.metadata_records += 1;
            events.push(json!({
                "kind": "historical_event",
                "event_type": event_type,
                "line": line,
                "timestamp": timestamp,
                "payload_sha256": value_digest(&Value::Object(payload.clone())),
                "executable": false,
            }));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn add_message(
    role: &str,
    text: &str,
    source_id: Option<&str>,
    timestamp: Option<&str>,
    model: Option<&str>,
    line: usize,
    source_sha256: &str,
    messages: &mut Vec<Value>,
    events: &mut Vec<Value>,
    report: &mut ConversionReport,
    seen_source_ids: &mut HashSet<String>,
    message_mirrors: &mut MessageMirrorState,
    origin: MessageOrigin,
) {
    if text.is_empty() {
        push_warning_once(
            report,
            "empty_message_skipped",
            "an empty Codex message was retained only in the raw archive",
        );
        return;
    }
    if let Some(source_id) = source_id {
        if !seen_source_ids.insert(source_id.to_string()) {
            report.duplicate_records += 1;
            push_warning_once(
                report,
                "duplicate_message_skipped",
                "a duplicate Codex message id was skipped from the normalized projection",
            );
            return;
        }
    }
    if message_mirrors.take_mirror(origin, role, text, line) {
        report.duplicate_records += 1;
        push_warning_once(
            report,
            "duplicate_message_skipped",
            "a nearby Codex response/event mirror was skipped from the normalized projection",
        );
        return;
    }
    let normalized_id = source_id
        .map(str::to_string)
        .unwrap_or_else(|| format!("codex:{source_sha256}:{line}"));
    messages.push(json!({
        "id": normalized_id,
        "role": role,
        "text": text,
        "source_id": source_id,
        "timestamp": timestamp,
        "model": model,
    }));
    events.push(json!({
        "kind": "message",
        "id": normalized_id,
        "role": role,
        "source_id": source_id,
        "timestamp": timestamp,
        "model": model,
        "line": line,
        "executable": false,
    }));
    message_mirrors.remember(origin, role, text, line);
}

/// Which side of the Codex response/event mirror produced a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MessageOrigin {
    ResponseItem,
    EventFallback,
}

#[derive(Debug, Clone)]
struct MessageMirror {
    origin: MessageOrigin,
    role: String,
    text: String,
    line: usize,
}

/// Pair only nearby messages from the two Codex projections. This is
/// deliberately local: equal user text in separate turns is valid history.
#[derive(Debug, Default)]
struct MessageMirrorState {
    pending: Vec<MessageMirror>,
}

impl MessageMirrorState {
    fn remember(&mut self, origin: MessageOrigin, role: &str, text: &str, line: usize) {
        self.pending.push(MessageMirror {
            origin,
            role: role.to_string(),
            text: text.to_string(),
            line,
        });
        self.pending
            .retain(|candidate| line.saturating_sub(candidate.line) <= MESSAGE_MIRROR_WINDOW_LINES);
    }

    fn take_mirror(&mut self, origin: MessageOrigin, role: &str, text: &str, line: usize) -> bool {
        let counterpart = match origin {
            MessageOrigin::ResponseItem => MessageOrigin::EventFallback,
            MessageOrigin::EventFallback => MessageOrigin::ResponseItem,
        };
        let Some(index) = self.pending.iter().rposition(|candidate| {
            candidate.origin == counterpart
                && candidate.role == role
                && candidate.text == text
                && line.abs_diff(candidate.line) <= MESSAGE_MIRROR_WINDOW_LINES
        }) else {
            self.pending.retain(|candidate| {
                line.saturating_sub(candidate.line) <= MESSAGE_MIRROR_WINDOW_LINES
            });
            return false;
        };
        self.pending.remove(index);
        true
    }
}

fn extract_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| match part {
                Value::String(text) => Some(text.as_str()),
                Value::Object(object) => {
                    let kind = object.get("type").and_then(Value::as_str);
                    match kind {
                        Some("input_text") | Some("output_text") | Some("text") | None => {
                            object.get("text").and_then(Value::as_str)
                        }
                        _ => None,
                    }
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Object(object)) => object
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    }
}

fn read_file_bounded(
    path: &Path,
    max_bytes: u64,
    token: &CancellationToken,
) -> Result<Vec<u8>, ProtocolError> {
    let mut file = File::open(path).map_err(|_| {
        ProtocolError::new("input_not_found", "the Codex rollout could not be opened")
    })?;
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        if token.is_cancelled() {
            return Err(ProtocolError::new(
                "cancelled",
                "Codex rollout import was cancelled",
            ));
        }
        let read = file.read(&mut buffer).map_err(|error| {
            ProtocolError::new("input_read_failed", "the Codex rollout could not be read")
                .with_data(json!({"io_kind": format!("{:?}", error.kind())}))
        })?;
        if read == 0 {
            break;
        }
        if (raw.len() as u64).saturating_add(read as u64) > max_bytes {
            return Err(ProtocolError::new(
                "input_too_large",
                format!("Codex rollout exceeds the {max_bytes} byte limit"),
            ));
        }
        raw.extend_from_slice(&buffer[..read]);
    }
    Ok(raw)
}

fn canonical_reference(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn first_string(value: &Value, keys: &[&str]) -> Option<String> {
    value
        .as_object()
        .and_then(|object| first_string_map(object, keys))
}

fn first_string_map(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| string_value(object.get(*key)))
}

fn string_value(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn value_digest(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn reject_unknown_fields(
    object: &serde_json::Map<String, Value>,
    allowed: &[&str],
) -> Result<(), ProtocolError> {
    if object
        .keys()
        .any(|field| !allowed.iter().any(|allowed| field == allowed))
    {
        return Err(ProtocolError::new(
            "invalid_params",
            "Codex import params contain an unknown field",
        ));
    }
    Ok(())
}

fn push_unknown(
    unknown_records: &mut Vec<Value>,
    _report: &mut ConversionReport,
    line: usize,
    record_type: Option<&str>,
    reason: &str,
) {
    if unknown_records.len() < MAX_REPORT_ENTRIES {
        unknown_records.push(json!({
            "line": line,
            "record_type": record_type,
            "reason": reason,
        }));
    }
}

fn push_warning(report: &mut ConversionReport, warning: Warning) {
    if report.warnings.len() < MAX_REPORT_ENTRIES {
        report.warnings.push(warning);
    }
}

fn push_warning_once(report: &mut ConversionReport, code: &str, message: &str) {
    if report.warnings.iter().any(|warning| warning.code == code) {
        return;
    }
    push_warning(
        report,
        Warning {
            code: code.to_string(),
            message: message.to_string(),
            line: None,
            record_type: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_CODEX_SHAPED_ROLLOUT: &str = include_str!("../tests/fixtures/codex-rollout.jsonl");

    #[test]
    fn real_codex_rollout_shapes_project_messages_and_non_executable_tools() {
        let digest = value_digest(&json!({"fixture": "codex"}));
        let result = parse_rollout(
            REAL_CODEX_SHAPED_ROLLOUT,
            &digest,
            REAL_CODEX_SHAPED_ROLLOUT.len() as u64,
            "fixture.jsonl".to_string(),
            None,
            &CancellationToken::new(),
        )
        .expect("fixture should import");

        assert_eq!(result["source"], "codex");
        assert_eq!(result["session"]["session_id"], "thread-01");
        assert_eq!(result["messages"].as_array().expect("messages").len(), 2);
        assert_eq!(result["events"][1]["kind"], "historical_tool_call");
        assert_eq!(result["events"][1]["executable"], false);
        assert_eq!(result["events"][2]["kind"], "historical_tool_result");
        assert_eq!(result["safety"]["history_replayed"], false);
        assert_eq!(result["conversion_report"]["unknown_records"], 1);
        assert_eq!(result["unknown_records"][0]["record_type"], "future_record");
    }

    #[test]
    fn event_message_does_not_duplicate_response_message() {
        let rollout = r#"{"type":"response_item","payload":{"type":"message","id":"m1","role":"user","content":[{"type":"input_text","text":"hello"}]}}
{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}
"#;
        let result = parse_rollout(
            rollout,
            "sha256:test",
            rollout.len() as u64,
            "fixture.jsonl".to_string(),
            None,
            &CancellationToken::new(),
        )
        .expect("fixture should import");
        assert_eq!(result["messages"].as_array().expect("messages").len(), 1);
        assert_eq!(result["conversion_report"]["duplicate_records"], 1);
    }

    #[test]
    fn repeated_text_in_separate_codex_turns_is_preserved() {
        let rollout = r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"OK"}]}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first"}]}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"OK"}]}}
"#;
        let result = parse_rollout(
            rollout,
            "sha256:test",
            rollout.len() as u64,
            "fixture.jsonl".to_string(),
            None,
            &CancellationToken::new(),
        )
        .expect("fixture should import");
        let messages = result["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["text"], "OK");
        assert_eq!(messages[2]["text"], "OK");
        assert_eq!(result["conversion_report"]["duplicate_records"], 0);
    }

    #[test]
    fn event_first_mirror_does_not_duplicate_response_item() {
        let rollout = r#"{"type":"event_msg","payload":{"type":"user_message","message":"continue"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}}
"#;
        let result = parse_rollout(
            rollout,
            "sha256:test",
            rollout.len() as u64,
            "fixture.jsonl".to_string(),
            None,
            &CancellationToken::new(),
        )
        .expect("fixture should import");
        assert_eq!(result["messages"].as_array().expect("messages").len(), 1);
        assert_eq!(result["conversion_report"]["duplicate_records"], 1);
    }

    #[test]
    fn malformed_lines_are_reported_without_exposing_line_content() {
        let rollout = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\"}}\nnot-json\n";
        let result = parse_rollout(
            rollout,
            "sha256:test",
            rollout.len() as u64,
            "fixture.jsonl".to_string(),
            None,
            &CancellationToken::new(),
        )
        .expect("valid records should still import");
        assert_eq!(result["conversion_report"]["malformed_records"], 1);
        let warning = &result["conversion_report"]["warnings"][0]["message"];
        assert!(!warning.as_str().expect("warning text").contains("not-json"));
    }

    #[test]
    fn raw_content_is_returned_only_when_requested() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "cyrene-codex-fixture-{}-{}.jsonl",
            std::process::id(),
            unique
        ));
        let rollout = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\"}}\n";
        fs::write(&path, rollout).expect("fixture should write");
        let result = import_rollout(
            &json!({"path": path.to_string_lossy(), "include_raw": true}),
            &CancellationToken::new(),
        )
        .expect("file should import");
        assert_eq!(result["raw"]["content"], rollout);
        fs::remove_file(path).expect("fixture should clean up");
    }
}
