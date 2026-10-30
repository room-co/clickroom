//! Token-scoped SSE for the support widget.
//!
//! `GET /v1/support/tickets/:id/stream` — a one-way server->widget stream that
//! tells a widget with an open thread that the thread changed, so it re-reads
//! `GET /v1/support/tickets/:id`. It mirrors the one-way posture of
//! `apps/api/src/flags/flags-stream.controller.ts`: authenticate, then hold a
//! thin, resource-bounded stream with a heartbeat and a server-side close.
//!
//! ## Why the "refetch ping" shape, not a full NATS fan-out
//!
//! An agent reply is written by the **control plane** (`support.router.ts`'s
//! `tickets.reply`), which has no NATS publisher — its own comment says so — and
//! reaches durable storage as a Postgres row plus a `SupportWebhookDelivery`
//! enqueue, never a NATS message capture consumes. capture, in turn, is only a
//! NATS *publisher* today (`main.rs` subscribes to nothing). Pushing agent
//! replies through NATS would mean adding a publisher to Node **and** a consumer
//! loop + subject fan-out to capture — well beyond what this stream warrants.
//!
//! So this degrades toward polling, but moves the poll **server-side**: the
//! widget holds a single SSE connection instead of re-fetching on a timer, and
//! the handler polls the ticket's public-thread activity signature
//! ([`store::load_thread_signature`]) on a short interval, emitting a `message`
//! event whenever it advances. The widget re-reads `getTicket` on that ping.
//! No WebSocket, no new dependency, no new NATS wiring.
//!
//! `typing` events are best-effort and there is no server-side signal source for
//! them in this variant, so none are emitted; the event name is reserved for a
//! later NATS-backed upgrade.

use std::{convert::Infallible, time::Duration};

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    response::sse::{Event, KeepAlive, Sse},
};
use futures::Stream;
use serde_json::json;

use crate::{
    error::ApiError,
    state::AppState,
    support::{
        endpoint::{authorize, authorized_ticket, extract_ticket_token, SupportQuery},
        store,
    },
};

/// How often the handler re-reads the thread signature. Short enough that a
/// reply feels live, long enough that one idle widget is a trickle of cheap
/// count queries rather than a busy loop.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Heartbeat cadence — axum emits an SSE comment when the stream has produced
/// nothing for this long, keeping proxies from reaping an idle connection.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// Hard cap on a single stream's lifetime. The widget's `EventSource`
/// reconnects on its own, so a bounded server-side close keeps connections from
/// piling up without dropping liveness. `600s / 3s` polls.
const MAX_TICKS: u32 = 200;

/// Per-connection loop state carried through [`futures::stream::unfold`].
struct StreamState {
    state: AppState,
    ticket_id: String,
    /// The last-seen `(message_count, max_created_at)` signature. Seeded at
    /// connect time so a message that lands between the widget's `getTicket` and
    /// this stream opening is still caught by the first poll.
    last_sig: (i64, Option<String>),
    ticks: u32,
}

/// `GET /v1/support/tickets/:id/stream`.
pub async fn ticket_stream_endpoint(
    State(state): State<AppState>,
    Path(ticket_id): Path<String>,
    Query(query): Query<SupportQuery>,
    headers: HeaderMap,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    // Same preamble as the thread read: project write-key + rate limit, then the
    // constant-time ticket-token compare. A caller that cannot read the thread
    // cannot subscribe to it either.
    let resolved = authorize(&state, &headers, &query).await?;
    let presented = extract_ticket_token(&headers, &query);
    let ticket = authorized_ticket(&state, &resolved, &ticket_id, presented.as_deref()).await?;

    // Seed the baseline before streaming so the first poll compares against the
    // thread as it is at connect time, not one poll interval later.
    let last_sig = store::load_thread_signature(&state, &ticket.id).await?;

    let init = StreamState {
        state,
        ticket_id: ticket.id,
        last_sig,
        ticks: 0,
    };

    let stream = futures::stream::unfold(init, |mut st| async move {
        loop {
            if st.ticks >= MAX_TICKS {
                return None;
            }
            tokio::time::sleep(POLL_INTERVAL).await;
            st.ticks += 1;

            match store::load_thread_signature(&st.state, &st.ticket_id).await {
                Ok(sig) => {
                    if sig != st.last_sig {
                        st.last_sig = sig;
                        let event = Event::default()
                            .event("message")
                            .data(json!({ "ticketId": st.ticket_id }).to_string());
                        return Some((Ok(event), st));
                    }
                    // No change: keep polling. The pending sleep lets axum's
                    // keep-alive emit its heartbeat in the meantime.
                }
                Err(e) => {
                    // A transient read failure must not tear the stream down —
                    // log and retry on the next tick, still bounded by MAX_TICKS.
                    tracing::warn!(
                        error = %e,
                        ticket_id = %st.ticket_id,
                        "support: thread-signature poll failed"
                    );
                }
            }
        }
    });

    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(KEEPALIVE_INTERVAL)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_lifetime_is_bounded_and_heartbeats_often() {
        // A stream that never closes on its own would accumulate connections;
        // the tick cap bounds a single subscription's lifetime, and the
        // keep-alive must fire many times within that life or a proxy would reap
        // an idle widget's connection before it ever closes.
        let max_lifetime = POLL_INTERVAL * MAX_TICKS;
        assert!(
            max_lifetime <= Duration::from_secs(30 * 60),
            "a single stream must not outlive a reasonable ceiling"
        );
        assert!(
            KEEPALIVE_INTERVAL < max_lifetime,
            "the heartbeat must fire well before the lifetime cap"
        );
    }
}
