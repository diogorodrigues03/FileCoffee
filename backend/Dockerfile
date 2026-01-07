# Build Stage
FROM rust:1-slim-bookworm as builder

WORKDIR /usr/src/app
COPY . .

# Install dependencies (openssl)
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

RUN cargo build --release

# Run Stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/app/target/release/backend /usr/local/bin/backend

WORKDIR /usr/local/bin

ENV PORT=3030
EXPOSE 3030

CMD ["backend"]
