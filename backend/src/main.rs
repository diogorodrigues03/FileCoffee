mod api;
mod types;

#[tokio::main]
async fn main() {
    api::create_endpoints().await;
}