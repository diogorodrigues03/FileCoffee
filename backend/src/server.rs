//! HTTP server loop.
//!
//! warp 0.4 no longer exposes the client's socket address to filters, which
//! rate limiting needs. This runs warp's service behind our own accept loop
//! (mirroring what `warp::serve` does) and attaches [`PeerAddr`] to every
//! request's extensions, where `warp::ext::optional::<PeerAddr>()` can read it.

use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::{TokioExecutor, TokioIo};
use hyper_util::server::conn::auto;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpListener;
use tower_service::Service;

/// The TCP peer address of the connection a request arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerAddr(pub SocketAddr);

pub async fn serve<S, B>(service: S, addr: SocketAddr) -> std::io::Result<()>
where
    S: Service<http::Request<Incoming>, Response = http::Response<B>, Error = Infallible>
        + Clone
        + Send
        + 'static,
    S::Future: Send + 'static,
    B: hyper::body::Body + Send + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let listener = TcpListener::bind(addr).await?;

    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                // e.g. out of file descriptors; back off instead of spinning
                tracing::warn!(error = %e, "Failed to accept connection");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };

        let service = service.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |mut req: http::Request<Incoming>| {
                req.extensions_mut().insert(PeerAddr(peer));
                let mut service = service.clone();
                async move { service.call(req).await }
            });

            if let Err(e) = auto::Builder::new(TokioExecutor::new())
                .http1()
                .serve_connection_with_upgrades(TokioIo::new(stream), svc)
                .await
            {
                tracing::debug!(error = %e, "Connection error");
            }
        });
    }
}
