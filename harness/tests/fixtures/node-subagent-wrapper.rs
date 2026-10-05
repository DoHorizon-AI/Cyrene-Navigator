//! Portable Windows fixture launcher for the round-one native protocol peer.
//! 第一轮原生协议 peer 的 Windows 可移植启动器。

use std::env;
use std::process::{self, Command, Stdio};

fn main() {
    let node = match env::var_os("FIXTURE_NODE") {
        Some(value) => value,
        None => fail("FIXTURE_NODE is required"),
    };
    let script = match env::var_os("FIXTURE_SCRIPT") {
        Some(value) => value,
        None => fail("FIXTURE_SCRIPT is required"),
    };

    let status = Command::new(node)
        .arg(script)
        .args(env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .unwrap_or_else(|_| fail("fixture Node process could not start"));
    process::exit(status.code().unwrap_or(1));
}

fn fail(message: &str) -> ! {
    eprintln!("round1 fixture wrapper: {message}");
    process::exit(2);
}
