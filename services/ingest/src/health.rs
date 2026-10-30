//! Minimal liveness listener for container healthchecks.
//!
//! ingest is otherwise a pure background consumer with no HTTP surface. This
//! serves `GET /health` -> `200 ok` on `INGEST_HEALTH_PORT` (default 3003; `0`
//! disables it). It is started only AFTER ClickHouse, Postgres, Redis and NATS
//! have all connected, so a 200 means "booted and wired up". If the consumer
//! loop dies the whole process exits, so the listener cannot outlive it.
//!
//! Hand-rolled on tokio's TCP types on purpose: one fixed response does not
//! justify pulling axum into this crate.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const DEFAULT_PORT: u16 = 3003;

const RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok";
const NOT_FOUND: &[u8] =
    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";

fn configured_port() -> anyhow::Result<u16> {
    match std::env::var("INGEST_HEALTH_PORT") {
        Ok(v) => v
            .parse::<u16>()
            .map_err(|e| anyhow::anyhow!("env var INGEST_HEALTH_PORT is invalid: {e}")),
        Err(_) => Ok(DEFAULT_PORT),
    }
}

fn is_health_request(head: &[u8]) -> bool {
    head.starts_with(b"GET /health ") || head.starts_with(b"GET /health?")
}

async fn serve_one(mut stream: TcpStream) {
    let mut buf = [0u8; 256];
    let n = stream.read(&mut buf).await.unwrap_or(0);
    let reply = if is_health_request(&buf[..n]) {
        RESPONSE
    } else {
        NOT_FOUND
    };
    let _ = stream.write_all(reply).await;
    let _ = stream.shutdown().await;
}

/// Bind and serve in the background. Returns an error only if the configured
/// port is invalid or cannot be bound (misconfiguration should fail loudly).
pub async fn spawn() -> anyhow::Result<()> {
    let port = configured_port()?;
    if port == 0 {
        tracing::info!("health listener disabled (INGEST_HEALTH_PORT=0)");
        return Ok(());
    }
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!(port, "health listener ready");
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    tokio::spawn(serve_one(stream));
                }
                Err(e) => {
                    tracing::warn!(error = %e, "health accept failed");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_health_request;

    #[test]
    fn matches_health_get_only() {
        assert!(is_health_request(b"GET /health HTTP/1.1\r\n"));
        assert!(is_health_request(b"GET /health?x=1 HTTP/1.1\r\n"));
        assert!(!is_health_request(b"GET /healthz HTTP/1.1\r\n"));
        assert!(!is_health_request(b"POST /health HTTP/1.1\r\n"));
        assert!(!is_health_request(b""));
    }
}
