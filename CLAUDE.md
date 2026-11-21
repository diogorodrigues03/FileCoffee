# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FileCoffee is a peer-to-peer file sharing app. Files never touch the server: a Rust (`warp`) backend only does WebSocket signaling and room bookkeeping, and the browser-to-browser transfer happens over a WebRTC data channel. The frontend is React 18 + TypeScript + Vite + Tailwind (shadcn/ui components in `src/components/ui`).

Two independent projects, no workspace tooling tying them together:
- `backend/` — Rust crate (edition 2024)
- `frontend/filecoffee-frontend/` — Vite app

## Commands

Backend (run from `backend/`):
```bash
cargo run            # listens on 0.0.0.0:$PORT (default 3030); reads backend/.env via dotenvy (copy from backend/.env.example; must be run from backend/)
cargo build
cargo clippy
cargo fmt
cargo test           # no tests exist yet
```
Logs are JSON via `tracing`; set verbosity with `RUST_LOG` (e.g. `RUST_LOG=debug cargo run`).

Frontend (run from `frontend/filecoffee-frontend/`):
```bash
npm install
npm run dev          # Vite dev server on port 8080 (see vite.config.ts)
npm run build        # tsc -b && vite build
npm run lint         # eslint
```
There is no frontend test runner configured.

Full stack with Docker (backend + frontend + local coturn TURN server):
```bash
docker-compose -f docker-compose.dev.yml up --build   # hot reload; frontend :8080, backend :3030
docker-compose up --build                              # production images; requires TURN_SECRET in ./.env (see .env.example)
```
`.env` files are gitignored; only the `.env.example` files are committed. The dev compose file falls back to the public `development_secret_key`, and the backend logs a warning at startup if that or any weak/shell-unsafe `TURN_SECRET` is used (`Config::turn_secret_warnings`).
coturn in both compose files is hardened with `--denied-peer-ip` for all private/loopback/link-local/reserved ranges, so it cannot be used to reach the backend, other containers or the LAN. Keep those flags when editing the compose files. The coturn image's entrypoint always logs a harmless `CONFIG: Unknown argument:` line.

## Architecture

### Signaling protocol (the contract between the two halves)

All signaling goes over one WebSocket at `/ws` using JSON messages tagged by a `type` field (serde `#[serde(tag = "type")]`). The Rust definitions in `backend/src/models/message.rs` (`ClientMessage`, `ServerMessage`, `error_codes`) are mirrored by hand in `frontend/filecoffee-frontend/src/constants/enums.ts`. **When changing a message, update both sides** — nothing generates or checks one from the other. Field names are snake_case on the wire (`room_id`, `has_password`).

Flow:
1. Sender sends `CreateRoom { password? }` → server replies `RoomCreated { room_id }`. The sender becomes the room's owner. Share link is `/download/:room_id`. Room IDs are `adjective-noun-<22-char base64url token>`; the 128-bit token is what makes them unguessable (`slug_generator.rs`) — never shorten it.
2. Receiver opens the link; frontend checks `GET /api/rooms/:id` (exists / has_password), then sends `JoinRoom { room_id, password? }`.
3. Server sends `PeerJoined { peer_id, peer_count }` to the sender, which shows an approval prompt. Nothing is transferred until the sender clicks "Send file"; then it creates the `RTCPeerConnection` + data channel (label `fileTransfer`) and sends an SDP offer. "Reject" sends `RejectPeer { peer_id }` (owner only): the server removes that peer, sends it an `Error` with code `REJECTED`, and closes its socket. Signals are only relayed from peers that are still room members.
4. SDP offers/answers and ICE candidates travel as opaque `Signal { data }` payloads; the backend just relays them to the other peers in the room (`SignalingService::broadcast_signal`) without inspecting them. `data` carries a sub-label (`offer`/`answer`/`candidate`/`progress`/`cancel`, see `SignalLabelType`).
5. File bytes go over the data channel (`lib/transfer/`, message types in `TransferMessageType`). The sender sends `metadata` (name, size). The receiver clicks "Save file", which opens a `FileSink` (`showSaveFilePicker`, else an OPFS temp file, else memory), and then replies `ready`. The sender then streams 256 KiB chunks, hashing incrementally with `hash-wasm`, and finishes with `done { sha256 }`. Flow control is `bufferedAmount` plus a 32 MiB window of bytes the receiver hasn't yet `ack`ed as written, so neither side holds the whole file in memory. The receiver treats everything from the peer as hostile: it sanitizes the file name, rejects bytes past the announced size or before `ready`, and only serves downloads as `application/octet-stream` (a sender-chosen MIME type on a `blob:` URL would run as this app's origin).

### Backend layout (`backend/src`)

- `main.rs` wires everything: `Config::from_env()` → `InMemoryRoomStore` → `RoomService` + `SignalingService` → warp routes, plus a background task that calls `cleanup_stale_rooms` every 60s. It only expires rooms where the sender has waited alone for `ROOM_TTL_SECONDS` (the idle clock restarts when a receiver leaves). A room with a receiver in it never expires, because a WebRTC transfer can run for hours without any signaling. Expired rooms get `ROOM_EXPIRED` and their socket is closed. Removed rooms are `mark_closed()` under the peers lock so a concurrent join can't land in them.
- `routes/` builds warp filters (`api.rs`: `/api/rooms/:id`, `/health`; `ws.rs`: `/ws` upgrade + per-connection read loop). Each connection gets an mpsc channel whose sender is stored on the `Peer` so other tasks can push messages to it.
- `handlers/ws_handler.rs` dispatches `ClientMessage`s and tracks per-connection state in `PeerContext`; `cleanup_peer` runs on disconnect.
- `services/room.rs` holds room business logic: room creation, capacity check via `room_max_peers` (default 2), and password protection. Argon2 is CPU/memory heavy, so it always goes through `run_argon2` (blocking thread pool + a semaphore of `ARGON2_MAX_CONCURRENT`) — never call Argon2 directly on an async task. Passwords are capped at `PASSWORD_MAX_LEN` (256). Each room allows `ROOM_MAX_PASSWORD_ATTEMPTS` (5) wrong guesses: a slot is reserved atomically *before* verifying (a correct password returns it), and the guess that exhausts the limit gets `TooManyPasswordAttempts`, after which the handler closes the room and sends `TOO_MANY_ATTEMPTS` to the sender. Empty or over-long guesses are rejected without using an attempt.
- `store/` defines the async `RoomStore` trait; `InMemoryRoomStore` is the only impl (rooms are lost on restart). New backends (Redis etc.) should implement this trait.
- `ice.rs` builds the ICE server list for one peer: Google STUN plus, if `TURN_URL` and `TURN_SECRET` are set, a TURN server with HMAC-SHA1 credentials (coturn `--use-auth-secret` scheme, username `<expiry>:<peer-id>`, lifetime `TURN_CREDENTIAL_TTL_SECS`). These are **only** delivered over the WebSocket — in `RoomJoined` to the joiner and in `PeerJoined` to the owner — never over HTTP, so TURN access requires being admitted to a room. The credential must outlive the transfer, since coturn re-checks it when allocations refresh.
- `config.rs` lists every env var and its default (also documented in `backend/.env.example`). Heartbeat and `ALLOWED_ORIGINS` are defined but not yet enforced; CORS currently allows any origin.
- `server.rs` runs warp's service behind our own accept loop. warp 0.4 dropped `warp::addr::remote()`, so this loop puts the TCP peer into each request's extensions as `PeerAddr`. `main.rs` must keep using `server::serve(warp::service(routes))`, not `warp::serve`, or rate limiting loses the client address.
- `middleware/rate_limit.rs`: per-client token buckets keyed by `ClientKey` (IPv4 address, or IPv6 /64). The client IP is the TCP peer, or taken from `X-Forwarded-For` only when `TRUSTED_PROXY_HOPS` > 0 (nth entry from the right). Limits: HTTP API per minute (`/health` exempt), WebSocket connects per minute and open connections per IP (checked before upgrade → HTTP 429), `CreateRoom`/`JoinRoom` per minute per IP, and a per-connection message bucket (exceeding it closes the socket). Rejections become JSON 429s with `Retry-After` in `handle_rejection` (main.rs); `.recover()` sits before `.with(cors)` so 429s carry CORS headers. Rate-limit log lines go through `RateLimits::log_limited` (one per client per minute). `MAX_ROOMS` is a global cap checked in `RoomService::create_room`.
- Route construction lives in `build_routes` (main.rs) so the integration tests in `main.rs` exercise the same filters. warp's test `WsBuilder` can't set extensions, so WebSocket tests pick a client IP via `X-Forwarded-For` with `trusted_proxy_hops = 1`.

### Frontend layout (`frontend/filecoffee-frontend/src`)

- Routes (`App.tsx`): `/` → `pages/Index.tsx` (sender), `/download/:room_id` → `pages/Download.tsx` (receiver, lazy-loaded).
- Incoming WebSocket messages are handled with a **Strategy pattern**: `lib/strategies/base.ts` defines `BaseStrategy`/`StrategyManager` keyed by `ServerMessageType`; `upload.ts` and `download.ts` register one strategy class per message type and receive a context object (React setters, refs to `WebSocket`/`RTCPeerConnection`/`RTCDataChannel`, toast, transfer callbacks). New server message handling goes into a new strategy class, not into the page components.
- Hooks: `useWebSocket` (no auto-reconnect on purpose: a new socket is in no room, so pages get `onUnexpectedClose` and tell the user; a close right after a server `Error` is already reported by the error strategy), `useWebRTC` (ICE servers are pushed in via `setIceServers` from the `RoomJoined`/`PeerJoined` strategies; falls back to public STUN), `useFileTransfer` (progress/speed/ETA stats), `useRoomValidation`.
- `config.ts`: `VITE_API_BASE_URL` (default same-origin) and `VITE_WS_BASE_URL` (default `ws://localhost:3030` in dev, same-origin `ws(s)://` in prod).
- `@/` is aliased to `src/`.

## Conventions

- Backend formatting config is in `backend/.prettierrc.toml` (4-space indent, 100-col width).
- Default branch for PRs is `main`; day-to-day work happens on `develop`.
