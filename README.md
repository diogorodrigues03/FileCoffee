# ☕ FileCoffee

FileCoffee is a secure, real-time, peer-to-peer (P2P) file sharing application. It allows you to share files of any size directly between devices without ever storing them on a server.

The application uses **WebRTC** for direct data transfer and a lightweight **Rust** backend for signaling. The frontend is built with **React**, **TypeScript**, and **Tailwind CSS** for a modern, responsive user experience.

![FileCoffee Logo](frontend/filecoffee-frontend/public/coffee-logo.png)

## ✨ Features

- **Peer-to-Peer Transfer:** Files go directly from the sender to the receiver. No intermediate storage.
- **Privacy First:** Since the server doesn't store files, your data remains private.
- **Real-time:** Instant connection and transfer start.
- **Password Protection:** Secure your file transfers with a password (optional).
- **Modern UI:** Clean and intuitive interface built with Radix UI and Tailwind CSS.
- **Cross-Platform:** Works in any modern web browser.

## 🏗 Architecture

FileCoffee operates on a P2P architecture:
1.  **Signaling:** The **Rust** backend (`warp`) acts as a signaling server. It helps two peers (browsers) find each other and exchange connection details (SDP offers/answers and ICE candidates).
2.  **Connection:** Once signaled, a direct **WebRTC** Data Channel is established between the two browsers.
3.  **Transfer:** The file is chunked and streamed directly over the WebRTC channel.

## 🛠 Tech Stack

### Backend
- **Language:** Rust 🦀
- **Framework:** [Warp](https://github.com/seanmonstar/warp) (Web Server & WebSockets)
- **Async Runtime:** Tokio
- **Utilities:** Serde, UUID

### Frontend
- **Framework:** React 18 (via Vite)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Components:** Radix UI (via shadcn/ui patterns), Lucide React (Icons)
- **Routing:** React Router DOM
- **State Management:** React Query (TanStack Query)

## 🚀 Getting Started

Follow these instructions to get a copy of the project running on your local machine.

### Prerequisites

- **Rust:** Install via [rustup.rs](https://rustup.rs/) (Ensure `cargo` is available).
- **Node.js:** Install the latest LTS version (Ensure `npm` is available).

### 1. Setup Backend

The backend handles the WebSocket signaling to connect peers.

```bash
# Navigate to the backend directory
cd backend

# Run the server
cargo run
```

The backend server will typically start on `http://127.0.0.1:3030` (or similar, check console output).

### 2. Setup Frontend

The frontend provides the user interface for uploading and downloading files.

```bash
# Open a new terminal and navigate to the frontend directory
cd frontend/filecoffee-frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

The frontend will start on `http://localhost:5173` (by default).

## 📖 Usage

1.  **Sender:** Open the app, select a file to upload.
2.  **Sender:** (Optional) Set a password for the transfer.
3.  **Sender:** Copy the generated share link.
4.  **Receiver:** Open the link in a different browser or device.
5.  **Receiver:** (If applicable) Enter the password.
6.  **Receiver:** The download starts immediately via WebRTC!

> **Note:** For P2P to work across different networks (not just localhost), you may need a STUN/TURN server configuration in your WebRTC setup. The default STUN servers (like Google's) usually work for most consumer NATs.
