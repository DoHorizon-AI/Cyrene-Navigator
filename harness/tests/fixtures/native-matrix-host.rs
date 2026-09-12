//! ┌─────────────────────────────────────────────────────────────────────┐
//! │ Fixture: Navigator native bridge fault matrix                      │
//! │ Role: Exercise the stdio supervisor on Windows without Node.       │
//! │ 固件职责：在 Windows 上脱离 Node 验证 stdio 监督边界。              │
//! └─────────────────────────────────────────────────────────────────────┘

use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::process;

const DIAGNOSTIC_SECRET: &str = "native-matrix-test-secret";
const CONFIG_FILE: &str = ".cyrene-native-fixture.json";

fn json_quote(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push('"');
    for character in value.chars() {
        match character {
            '"' => encoded.push_str("\\\""),
            '\\' => encoded.push_str("\\\\"),
            '\n' => encoded.push_str("\\n"),
            '\r' => encoded.push_str("\\r"),
            '\t' => encoded.push_str("\\t"),
            '\u{08}' => encoded.push_str("\\b"),
            '\u{0c}' => encoded.push_str("\\f"),
            character if character.is_control() => {
                encoded.push_str(&format!("\\u{:04x}", u32::from(character)));
            }
            character => encoded.push(character),
        }
    }
    encoded.push('"');
    encoded
}

fn parse_json_string(input: &str) -> Option<(String, usize)> {
    let mut characters = input.char_indices();
    if characters.next()?.1 != '"' {
        return None;
    }
    let mut value = String::new();
    while let Some((offset, character)) = characters.next() {
        match character {
            '"' => return Some((value, offset + character.len_utf8())),
            '\\' => {
                let escaped = characters.next()?.1;
                match escaped {
                    '"' => value.push('"'),
                    '\\' => value.push('\\'),
                    '/' => value.push('/'),
                    'b' => value.push('\u{08}'),
                    'f' => value.push('\u{0c}'),
                    'n' => value.push('\n'),
                    'r' => value.push('\r'),
                    't' => value.push('\t'),
                    'u' => {
                        let mut digits = String::with_capacity(4);
                        for _ in 0..4 {
                            digits.push(characters.next()?.1);
                        }
                        let code = u16::from_str_radix(&digits, 16).ok()?;
                        value.push(char::from_u32(u32::from(code))?);
                    }
                    _ => return None,
                }
            }
            character if character.is_control() => return None,
            character => value.push(character),
        }
    }
    None
}

fn json_string_field(line: &str, key: &str) -> Option<String> {
    let marker = format!("\"{key}\"");
    let start = line.find(&marker)? + marker.len();
    let remainder = line[start..].trim_start().strip_prefix(':')?.trim_start();
    parse_json_string(remainder).map(|(value, _)| value)
}

fn state(path: &str, status: &str, fields: &str) {
    let suffix = if fields.is_empty() {
        String::new()
    } else {
        format!(",{fields}")
    };
    let payload = format!(
        r#"{{"status":{},"pid":{}{}}}"#,
        json_quote(status),
        process::id(),
        suffix,
    );
    let _ = fs::write(path, payload);
}

fn send(frame: String) {
    let mut stdout = io::stdout().lock();
    if writeln!(stdout, "{frame}")
        .and_then(|_| stdout.flush())
        .is_err()
    {
        process::exit(1);
    }
}

fn finish(code: i32, state_path: &str) -> ! {
    state(state_path, "exited", &format!("\"code\":{code}"));
    process::exit(code);
}

fn main() {
    let config_path = env::current_dir()
        .expect("fixture current directory")
        .join(CONFIG_FILE);
    let config = fs::read_to_string(config_path).expect("fixture configuration");
    let mode = json_string_field(&config, "mode").expect("fixture mode");
    let state_path = json_string_field(&config, "statePath").expect("fixture state path");

    state(
        &state_path,
        "started",
        &format!("\"mode\":{}", json_quote(&mode)),
    );
    if mode == "oversized-stdout" {
        let mut stdout = io::stdout().lock();
        let _ = stdout.write_all(&vec![b'x'; 128 * 1024]);
        let _ = stdout.flush();
    }
    if mode == "stdout-log" {
        let mut stdout = io::stdout().lock();
        let _ = stdout.write_all(format!("diagnostic:{DIAGNOSTIC_SECRET}\n").as_bytes());
        let _ = stdout.flush();
    }
    if mode == "stderr-cap" {
        let mut diagnostics = Vec::with_capacity(DIAGNOSTIC_SECRET.len() + 64 * 1024);
        diagnostics.extend_from_slice(DIAGNOSTIC_SECRET.as_bytes());
        diagnostics.extend(std::iter::repeat_n(b'x', 64 * 1024));
        let mut stderr = io::stderr().lock();
        let _ = stderr.write_all(&diagnostics);
        let _ = stderr.flush();
    }

    let reader = BufReader::new(io::stdin().lock());
    let mut active_request_id: Option<String> = None;
    let mut request_seen = false;
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if line.is_empty() {
            continue;
        }
        let Some(method) = json_string_field(&line, "method") else {
            continue;
        };
        let id = json_string_field(&line, "id").unwrap_or_default();
        if method == "hello" {
            if mode == "version-mismatch" {
                send(format!(
                    r#"{{"version":2,"id":{},"result":{{"protocol_version":2}}}}"#,
                    json_quote(&id),
                ));
                continue;
            }
            let protocol_version = if mode == "handshake-mismatch" { 2 } else { 1 };
            send(format!(
                r#"{{"version":1,"id":{},"result":{{"protocol_version":{protocol_version}}}}}"#,
                json_quote(&id),
            ));
            state(&state_path, "handshake", "");
            if mode == "crash" || mode == "eof" {
                finish(if mode == "crash" { 17 } else { 0 }, &state_path);
            }
            continue;
        }
        if method == "fixture_operation" {
            request_seen = true;
            active_request_id = Some(id.clone());
            state(
                &state_path,
                "active",
                &format!("\"request_id\":{}", json_quote(&id)),
            );
            if mode == "active-cancel" || mode == "active-timeout" {
                send(format!(
                    r#"{{"version":1,"event":"request_started","request_id":{},"data":{{"pid":{}}}}}"#,
                    json_quote(&id),
                    process::id(),
                ));
                continue;
            }
            let secret_present = env::var_os("CYRENE_NATIVE_TEST_SECRET").is_some();
            let stderr_bytes = if mode == "stderr-cap" {
                DIAGNOSTIC_SECRET.len() + 64 * 1024
            } else {
                0
            };
            send(format!(
                r#"{{"version":1,"id":{},"result":{{"ok":true,"request_id":{},"secret_env_present":{secret_present},"stderr_bytes_written":{stderr_bytes}}}}}"#,
                json_quote(&id),
                json_quote(&id),
            ));
            state(&state_path, "result", "");
            continue;
        }
        if method == "cancel" {
            let target = json_string_field(&line, "request_id").unwrap_or_default();
            let accepted = active_request_id.as_deref() == Some(target.as_str());
            state(
                &state_path,
                "cancel-received",
                &format!("\"request_id\":{}", json_quote(&target)),
            );
            send(format!(
                r#"{{"version":1,"id":{},"result":{{"accepted":{accepted}}}}}"#,
                json_quote(&id),
            ));
            if accepted && mode == "active-cancel" {
                send(format!(
                    r#"{{"version":1,"id":{},"error":{{"code":"cancelled","message":"fixture observed cancel"}}}}"#,
                    json_quote(&target),
                ));
                finish(0, &state_path);
            }
        }
    }

    if !request_seen || mode == "stderr-cap" {
        finish(0, &state_path);
    }
    finish(0, &state_path);
}
