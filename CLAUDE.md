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
cargo run            # listens on 0.0.0.0:$PORT (default 3030); reads backend/.env via dotenvy
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
docker-compose up --build                              # production images
```

## Architecture

### Signaling protocol (the contract between the two halves)

All signaling goes over one WebSocket at `/ws` using JSON messages tagged by a `type` field (serde `#[serde(tag = "type")]`). The Rust definitions in `backend/src/models/message.rs` (`ClientMessage`, `ServerMessage`, `error_codes`) are mirrored by hand in `frontend/filecoffee-frontend/src/constants/enums.ts`. **When changing a message, update both sides** — nothing generates or checks one from the other. Field names are snake_case on the wire (`room_id`, `has_password`).

Flow:
1. Sender sends `CreateRoom { password? }` → server replies `RoomCreated { room_id }`. The sender becomes the room's owner. Share link is `/download/:room_id`. Room IDs are `adjective-noun-<22-char base64url token>`; the 128-bit token is what makes them unguessable (`slug_generator.rs`) — never shorten it.
2. Receiver opens the link; frontend checks `GET /api/rooms/:id` (exists / has_password), then sends `JoinRoom { room_id, password? }`.
3. Server sends `PeerJoined { peer_id, peer_count }` to the sender, which shows an approval prompt. Nothing is transferred until the sender clicks "Send file"; then it creates the `RTCPeerConnection` + data channel (label `fileTransfer`) and sends an SDP offer. "Reject" sends `RejectPeer { peer_id }` (owner only): the server removes that peer, sends it an `Error` with code `REJECTED`, and closes its socket. Signals are only relayed from peers that are still room members.
4. SDP offers/answers and ICE candidates travel as opaque `Signal { data }` payloads; the backend just relays them to the other peers in the room (`SignalingService::broadcast_signal`) without inspecting them. `data` carries a sub-label (`offer`/`answer`/`candidate`/`progress`/`cancel`, see `SignalLabelType`).
5. File bytes go over the data channel: a JSON metadata message first, then 256 KiB chunks with backpressure on `bufferedAmount`; a SHA-256 is computed for integrity (`lib/utils.ts`).

### Backend layout (`backend/src`)

- `main.rs` wires everything: `Config::from_env()` → `InMemoryRoomStore` → `RoomService` + `SignalingService` → warp routes, plus a background task that calls `cleanup_stale_rooms` every 60s.
- `routes/` builds warp filters (`api.rs`: `/api/rooms/:id`, `/api/ice-servers`, `/health`; `ws.rs`: `/ws` upgrade + per-connection read loop). Each connection gets an mpsc channel whose sender is stored on the `Peer` so other tasks can push messages to it.
- `handlers/ws_handler.rs` dispatches `ClientMessage`s and tracks per-connection state in `PeerContext`; `cleanup_peer` runs on disconnect.
- `services/room.rs` holds room business logic (slug generation with UUID fallback, Argon2 password hashing/verification, capacity check via `room_max_peers`, default 2).
- `store/` defines the async `RoomStore` trait; `InMemoryRoomStore` is the only impl (rooms are lost on restart). New backends (Redis etc.) should implement this trait.
- `ice.rs` returns a Google STUN server plus, if `TURN_URL` and `TURN_SECRET` are set, a TURN server with ephemeral HMAC-SHA1 credentials (coturn `--use-auth-secret` scheme). Note it reads env vars directly rather than using `Config`.
- `config.rs` lists every env var and its default (`PORT`, `ROOM_TTL_SECONDS`, `ROOM_MAX_PEERS`, `TURN_*`, `RATE_LIMIT_RPM`, `WS_*`, `ALLOWED_ORIGINS`). Several of these (rate limiting, heartbeat, allowed origins) are defined but not yet enforced; `middleware/rate_limit.rs` is an empty stub and `middleware` is not declared in `main.rs`. CORS currently allows any origin.

### Frontend layout (`frontend/filecoffee-frontend/src`)

- Routes (`App.tsx`): `/` → `pages/Index.tsx` (sender), `/download/:room_id` → `pages/Download.tsx` (receiver, lazy-loaded).
- Incoming WebSocket messages are handled with a **Strategy pattern**: `lib/strategies/base.ts` defines `BaseStrategy`/`StrategyManager` keyed by `ServerMessageType`; `upload.ts` and `download.ts` register one strategy class per message type and receive a context object (React setters, refs to `WebSocket`/`RTCPeerConnection`/`RTCDataChannel`, toast, transfer callbacks). New server message handling goes into a new strategy class, not into the page components.
- Hooks: `useWebSocket`, `useWebRTC` (fetches ICE config from `/api/ice-servers`), `useFileTransfer` (progress/speed/ETA stats), `useRoomValidation`.
- `config.ts`: `VITE_API_BASE_URL` (default same-origin) and `VITE_WS_BASE_URL` (default `ws://localhost:3030` in dev, same-origin `ws(s)://` in prod).
- `@/` is aliased to `src/`.

## Conventions

- Backend formatting config is in `backend/.prettierrc.toml` (4-space indent, 100-col width).
- Default branch for PRs is `main`; day-to-day work happens on `develop`.
