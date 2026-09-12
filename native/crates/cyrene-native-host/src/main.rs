//! ┌─────────────────────────────────────────────────────────────────────┐
//! │  📄 main.rs                                                          │
//! │  Module: cyrene_native_host                                           │
//! │  Role: Run the versioned Navigator stdio bridge and dispatch methods. │
//! │                                                                      │
//! │  模块职责：运行版本化 Navigator stdio bridge 并分发请求。             │
//! └─────────────────────────────────────────────────────────────────────┘

mod codex;
mod process;
mod protocol;

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use serde_json::{json, Value};

use crate::process::CancellationToken;
use crate::protocol::{
    validate_identifier, Event, ProtocolError, Request, Response, MAX_REQUEST_LINE_BYTES,
    PROTOCOL_VERSION,
};

const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
type PendingRequests = Arc<Mutex<HashMap<String, CancellationToken>>>;
type Output = Arc<Mutex<BufWriter<io::Stdout>>>;

fn main() {
    match parse_config(std::env::args().skip(1)) {
        Ok(()) => {
            if let Err(error) = run() {
                eprintln!("cyrene-native-host: {error}");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("cyrene-native-host: {error}");
            std::process::exit(2);
        }
    }
}

fn parse_config<I>(mut arguments: I) -> Result<(), String>
where
    I: Iterator<Item = String>,
{
    let Some(argument) = arguments.next() else {
        return Ok(());
    };
    match argument.as_str() {
        "--help" | "-h" => {
            print_help();
            std::process::exit(0);
        }
        "--version" | "-V" => {
            println!("cyrene-native-host {HOST_VERSION}");
            std::process::exit(0);
        }
        value => Err(format!("unknown argument '{value}'")),
    }
}

fn print_help() {
    println!(
        "cyrene-native-host {HOST_VERSION}\n\n\
         Reads protocol v1 NDJSON from stdin and writes responses/events to stdout."
    );
}

fn run() -> io::Result<()> {
    let output = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let pending: PendingRequests = Arc::new(Mutex::new(HashMap::new()));
    let mut workers: Vec<JoinHandle<()>> = Vec::new();
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());

    loop {
        match read_line_bounded(&mut reader)? {
            LineRead::Eof => break,
            LineRead::TooLarge => {
                write_response(
                    &output,
                    Response::failure(
                        "unknown",
                        ProtocolError::new(
                            "request_too_large",
                            "request line exceeds the protocol size limit",
                        ),
                    ),
                )?;
            }
            LineRead::Line(line) => {
                if line.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                dispatch_line(line, &output, &pending, &mut workers)?;
            }
        }
    }

    // EOF is a lifecycle boundary: no child process or worker may survive the
    // host that owns its request stream.
    cancel_pending(&pending);
    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

fn dispatch_line(
    line: Vec<u8>,
    output: &Output,
    pending: &PendingRequests,
    workers: &mut Vec<JoinHandle<()>>,
) -> io::Result<()> {
    let request: Request = match serde_json::from_slice(&line) {
        Ok(request) => request,
        Err(_) => {
            return write_response(
                output,
                Response::failure(
                    "unknown",
                    ProtocolError::new("invalid_json", "request line is not valid JSON"),
                ),
            );
        }
    };
    if let Err(error) = request.validate() {
        return write_response(output, Response::failure(request.id, error));
    }

    if request.method == "cancel" {
        return dispatch_cancel(request, output, pending);
    }

    let token = CancellationToken::new();
    {
        let mut requests = pending
            .lock()
            .map_err(|_| io::Error::other("pending request lock poisoned"))?;
        if requests.contains_key(&request.id) {
            return write_response(
                output,
                Response::failure(
                    request.id,
                    ProtocolError::new("duplicate_request", "request id is already running"),
                ),
            );
        }
        requests.insert(request.id.clone(), token.clone());
    }

    let id = request.id.clone();
    let method = request.method.clone();
    let params = request.params;
    let output = Arc::clone(output);
    let pending = Arc::clone(pending);
    let worker = thread::Builder::new()
        .name(format!("cyrene-native-{id}"))
        .spawn(move || {
            let _ = write_event(
                &output,
                Event::new("request_started", id.clone(), json!({"method": method})),
            );
            let result = dispatch_method(&method, &params, &token);
            let response = match result {
                Ok(result) => Response::success(id.clone(), result),
                Err(error) => Response::failure(id.clone(), error),
            };
            let _ = write_response(&output, response);
            if let Ok(mut requests) = pending.lock() {
                requests.remove(&id);
            }
        })
        .map_err(|error| io::Error::other(format!("could not start request worker: {error}")))?;
    workers.push(worker);
    Ok(())
}

fn dispatch_cancel(request: Request, output: &Output, pending: &PendingRequests) -> io::Result<()> {
    let object = request.params.as_object().ok_or_else(|| {
        io::Error::other("cancel params must be an object after request validation")
    })?;
    if object.len() != 1 || !object.contains_key("request_id") {
        return write_response(
            output,
            Response::failure(
                request.id,
                ProtocolError::new(
                    "invalid_params",
                    "cancel params must contain only request_id",
                ),
            ),
        );
    }
    let Some(target) = object.get("request_id").and_then(Value::as_str) else {
        return write_response(
            output,
            Response::failure(
                request.id,
                ProtocolError::new("invalid_params", "cancel request_id must be a string"),
            ),
        );
    };
    if let Err(error) = validate_identifier(target, "cancel request_id") {
        return write_response(output, Response::failure(request.id, error));
    }
    let token = pending
        .lock()
        .map_err(|_| io::Error::other("pending request lock poisoned"))?
        .get(target)
        .cloned();
    match token {
        Some(token) => {
            token.cancel();
            write_response(
                output,
                Response::success(request.id, json!({"request_id": target, "accepted": true})),
            )
        }
        None => write_response(
            output,
            Response::failure(
                request.id,
                ProtocolError::new("request_not_found", "request is not running"),
            ),
        ),
    }
}

fn dispatch_method(
    method: &str,
    params: &Value,
    token: &CancellationToken,
) -> Result<Value, ProtocolError> {
    match method {
        "hello" => {
            ensure_empty_params(params)?;
            Ok(json!({
                "protocol": "cyrene.native.v1",
                "protocol_version": PROTOCOL_VERSION,
                "host": "cyrene-native-host",
                "host_version": HOST_VERSION,
                "capabilities": [
                    "import_codex_rollout",
                    "cancel",
                ],
            }))
        }
        "import_codex_rollout" => codex::import_rollout(params, token),
        _ => Err(ProtocolError::new(
            "unsupported_method",
            "the requested native host method is not registered",
        )),
    }
}

fn ensure_empty_params(params: &Value) -> Result<(), ProtocolError> {
    let object = params
        .as_object()
        .ok_or_else(|| ProtocolError::new("invalid_params", "method params must be an object"))?;
    if object.is_empty() {
        Ok(())
    } else {
        Err(ProtocolError::new(
            "invalid_params",
            "hello does not accept method parameters",
        ))
    }
}

fn cancel_pending(pending: &PendingRequests) {
    if let Ok(requests) = pending.lock() {
        for token in requests.values() {
            token.cancel();
        }
    }
}

fn write_response(output: &Output, response: Response) -> io::Result<()> {
    write_json_line(output, &response)
}

fn write_event(output: &Output, event: Event) -> io::Result<()> {
    write_json_line(output, &event)
}

fn write_json_line<T: serde::Serialize>(output: &Output, value: &T) -> io::Result<()> {
    let mut writer = output
        .lock()
        .map_err(|_| io::Error::other("stdout lock poisoned"))?;
    serde_json::to_writer(&mut *writer, value)
        .map_err(|error| io::Error::other(format!("could not encode protocol message: {error}")))?;
    writer.write_all(b"\n")?;
    writer.flush()
}

enum LineRead {
    Eof,
    TooLarge,
    Line(Vec<u8>),
}

fn read_line_bounded<R: BufRead>(reader: &mut R) -> io::Result<LineRead> {
    let mut line = Vec::new();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(LineRead::Eof)
            } else {
                Ok(LineRead::Line(line))
            };
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let requested = newline.map_or(buffer.len(), |index| index + 1);
        let remaining = MAX_REQUEST_LINE_BYTES
            .saturating_add(1)
            .saturating_sub(line.len());
        let take = requested.min(remaining);
        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if take < requested {
            // Drain the oversized line so the next call starts at a record
            // boundary, without retaining unbounded attacker-controlled data.
            loop {
                let buffer = reader.fill_buf()?;
                if buffer.is_empty() {
                    break;
                }
                if let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                    reader.consume(index + 1);
                    break;
                }
                let length = buffer.len();
                reader.consume(length);
            }
            return Ok(LineRead::TooLarge);
        }
        if newline.is_some() {
            if line.len() > MAX_REQUEST_LINE_BYTES {
                return Ok(LineRead::TooLarge);
            }
            return Ok(LineRead::Line(line));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_rejects_unknown_external_tool_argument() {
        let error = parse_config(vec!["--external-tool=/opt/tool".to_string()].into_iter())
            .expect_err("retired Platform argument must fail closed");
        assert!(error.contains("unknown argument"));
    }

    #[test]
    fn bounded_reader_preserves_records_after_an_oversized_line() {
        let oversized = "x".repeat(MAX_REQUEST_LINE_BYTES + 10);
        let input = format!("{oversized}\n{{\"ok\":true}}\n");
        let mut reader = BufReader::new(input.as_bytes());
        assert!(matches!(
            read_line_bounded(&mut reader).expect("read should succeed"),
            LineRead::TooLarge
        ));
        assert!(matches!(
            read_line_bounded(&mut reader).expect("read should succeed"),
            LineRead::Line(line) if line == b"{\"ok\":true}\n"
        ));
    }

    #[test]
    fn dispatches_hello_with_only_navigator_capabilities() {
        let result = dispatch_method("hello", &json!({}), &CancellationToken::new())
            .expect("hello should succeed");
        assert_eq!(result["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(
            result["capabilities"],
            json!(["import_codex_rollout", "cancel"])
        );
    }
}
