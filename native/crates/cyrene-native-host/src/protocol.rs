//! ┌─────────────────────────────────────────────────────────────────────┐
//! │  📄 protocol.rs                                                      │
//! │  Module: cyrene_native_host::protocol                                │
//! │  Role: Versioned NDJSON request, response, and event envelopes.      │
//! │                                                                      │
//! │  模块职责：定义版本化 NDJSON 请求、响应和事件信封。                   │
//! └─────────────────────────────────────────────────────────────────────┘

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The only wire version accepted by this proof bridge.
pub const PROTOCOL_VERSION: u32 = 1;

/// Maximum bytes accepted for one input line, including the line ending.
pub const MAX_REQUEST_LINE_BYTES: usize = 4 * 1024 * 1024;

/// A request sent by the Cordis plugin over inherited stdin.
#[derive(Debug, Deserialize)]
pub struct Request {
    /// Wire protocol version.
    pub version: u32,
    /// Caller-owned request identifier. It is echoed unchanged in responses.
    pub id: String,
    /// Registered host method name.
    pub method: String,
    /// Method-specific JSON object, defaulting to an empty object.
    #[serde(default = "empty_object")]
    pub params: Value,
}

impl Request {
    /// Validate envelope-level invariants before dispatching a method.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.version != PROTOCOL_VERSION {
            return Err(ProtocolError::new(
                "protocol_version_mismatch",
                format!(
                    "unsupported protocol version {}; expected {}",
                    self.version, PROTOCOL_VERSION
                ),
            ));
        }
        validate_identifier(&self.id, "request id")?;
        validate_identifier(&self.method, "method")?;
        if !self.params.is_object() {
            return Err(ProtocolError::new(
                "invalid_params",
                "request params must be a JSON object",
            ));
        }
        Ok(())
    }
}

/// A structured error returned to the Cordis plugin.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorBody {
    /// Stable machine-readable error code.
    pub code: String,
    /// Safe human-readable description. Raw tool output is never logged here.
    pub message: String,
    /// Optional structured diagnostics such as an exit code or digest.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A response envelope containing exactly one success or error branch.
#[derive(Debug, Serialize)]
pub struct Response {
    /// Wire protocol version.
    pub version: u32,
    /// Request identifier echoed from the request.
    pub id: String,
    /// Successful method result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Structured method failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorBody>,
}

impl Response {
    /// Build a successful response.
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            result: Some(result),
            error: None,
        }
    }

    /// Build an error response.
    pub fn failure(id: impl Into<String>, error: ProtocolError) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            result: None,
            error: Some(error.into()),
        }
    }
}

/// An asynchronous event emitted before a long-running result.
#[derive(Debug, Serialize)]
pub struct Event {
    /// Wire protocol version.
    pub version: u32,
    /// Event name registered by the host contract.
    pub event: String,
    /// Request whose lifecycle produced this event.
    pub request_id: String,
    /// Event-specific data.
    pub data: Value,
}

impl Event {
    /// Build an event envelope.
    pub fn new(event: impl Into<String>, request_id: impl Into<String>, data: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            event: event.into(),
            request_id: request_id.into(),
            data,
        }
    }
}

/// A protocol-level validation or dispatch error.
#[derive(Debug, Clone)]
pub struct ProtocolError {
    /// Stable machine-readable error code.
    pub code: String,
    /// Safe human-readable message.
    pub message: String,
    /// Optional structured data.
    pub data: Option<Value>,
}

impl ProtocolError {
    /// Construct an error without additional data.
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            data: None,
        }
    }

    /// Attach structured diagnostics to an existing error.
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

impl From<ProtocolError> for ErrorBody {
    fn from(error: ProtocolError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            data: error.data,
        }
    }
}

/// Validate a bounded identifier carried by the protocol.
pub fn validate_identifier(value: &str, label: &str) -> Result<(), ProtocolError> {
    if value.is_empty() {
        return Err(ProtocolError::new(
            "invalid_request",
            format!("{label} must not be empty"),
        ));
    }
    if value.len() > 256 {
        return Err(ProtocolError::new(
            "invalid_request",
            format!("{label} exceeds the 256-byte limit"),
        ));
    }
    if value.chars().any(|character| character.is_control()) {
        return Err(ProtocolError::new(
            "invalid_request",
            format!("{label} contains a control character"),
        ));
    }
    Ok(())
}

fn empty_object() -> Value {
    Value::Object(serde_json::Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_defaults_params_to_an_object() {
        let request: Request =
            serde_json::from_str(r#"{"version":1,"id":"hello","method":"ping"}"#)
                .expect("request should deserialize");
        assert!(request.params.is_object());
        request.validate().expect("request should validate");
    }

    #[test]
    fn request_rejects_wrong_version_and_non_object_params() {
        let wrong_version: Request =
            serde_json::from_str(r#"{"version":2,"id":"x","method":"ping","params":{}}"#)
                .expect("request should deserialize");
        assert_eq!(
            wrong_version
                .validate()
                .expect_err("version should fail")
                .code,
            "protocol_version_mismatch"
        );

        let wrong_params: Request =
            serde_json::from_str(r#"{"version":1,"id":"x","method":"ping","params":[]}"#)
                .expect("request should deserialize");
        assert_eq!(
            wrong_params
                .validate()
                .expect_err("params should fail")
                .code,
            "invalid_params"
        );
    }

    #[test]
    fn response_serializes_one_result_branch() {
        let encoded = serde_json::to_value(Response::success("x", serde_json::json!({"ok":true})))
            .expect("response should serialize");
        assert_eq!(encoded["version"], 1);
        assert_eq!(encoded["id"], "x");
        assert!(encoded.get("error").is_none());
    }
}
