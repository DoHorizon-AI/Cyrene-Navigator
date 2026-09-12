//! ┌─────────────────────────────────────────────────────────────────────┐
//! │  📄 process.rs                                                       │
//! │  Module: cyrene_native_host::process                                 │
//! │  Role: Coordinate cancellation of Navigator-owned native work.       │
//! │                                                                      │
//! │  模块职责：协调 Navigator 自有原生任务的取消。                        │
//! └─────────────────────────────────────────────────────────────────────┘

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// Cooperative cancellation flag shared by the request dispatcher and worker.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    /// Create a new non-cancelled token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark the associated operation as cancelled.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    /// Return whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_token_is_shared_by_clones() {
        let first = CancellationToken::new();
        let second = first.clone();
        assert!(!second.is_cancelled());
        first.cancel();
        assert!(second.is_cancelled());
    }
}
