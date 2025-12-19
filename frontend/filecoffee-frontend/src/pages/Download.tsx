import EnterPassword from "@/components/EnterPassword";
import { useEffect, useRef, useState } from "react";
import coffeeLogoImg from "@/assets/coffee-logo.png";
import FileDownload from "@/components/FileDownload";
import {
  ViewType,
  ClientMessage,
  ClientMessageType,
  ServerMessage,
  ServerMessageType,
} from "@/constants/enums.ts";
import { useParams } from "react-router-dom";

const Download = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.PASSWORD);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const { room_id } = useParams<{ room_id: string }>();

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  function handlePasswordSubmit(password: string) {
    if (!room_id) return;

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    setError(null);

    // Create WebSocket connection
    const ws = new WebSocket("ws://localhost:3030/ws");
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Connected to WebSocket");
      const msg: ClientMessage = {
        type: ClientMessageType.JoinRoom,
        room_id,
        password: password || undefined,
      };
      ws.send(JSON.stringify(msg));
    };

    ws.onmessage = (event) => {
      try {
        const message: ServerMessage = JSON.parse(event.data);
        console.log("WebSocket message received:", message);

        switch (message.type) {
          case ServerMessageType.RoomJoined:
            setCurrentView(ViewType.DOWNLOAD);
            break;
          case ServerMessageType.Error:
            setError(message.message);
            break;
          default:
            break;
        }
      } catch (e) {
        console.error("Failed to parse message:", e);
        setError("An unexpected error occurred.");
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      setError("Failed to connect to the server.");
    };

    ws.onclose = () => {
      console.log("WebSocket connection closed");
      wsRef.current = null;
    };
  }

  return (
    <div className="min-h-screen bg-gradient-cream flex flex-col">
      {/* Header */}
      <header className="pt-12 pb-8">
        <div className="max-w-4xl mx-auto flex flex-col items-center">
          <img src={coffeeLogoImg} alt="Coffee Transfer" className="h-48" />
          <div className="text-center">
            <h1 className="text-4xl font-bold bg-gradient-coffee bg-clip-text text-transparent mb-2">
              Coffee Transfer
            </h1>
            <p className="text-muted-foreground">
              Share files securely, smooth as your morning brew
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center mt-8">
        <div className="w-full max-w-4xl mx-auto">
          {currentView === ViewType.DOWNLOAD && <FileDownload />}

          {currentView === ViewType.PASSWORD && (
            <>
              <EnterPassword handlePasswordSubmit={handlePasswordSubmit} />
              {error && (
                <p className="text-red-500 text-center mt-4">{error}</p>
              )}
            </>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="py-6 px-4 border-t border-border/50">
        <p className="text-center text-sm text-muted-foreground">
          Powered by WebSockets · End-to-end transfer
        </p>
      </footer>
    </div>
  );
};

export default Download;
