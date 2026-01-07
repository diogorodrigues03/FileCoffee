import { useRef, useState } from "react";
import { FileUpload } from "@/components/FileUpload";
import { PasswordSetup } from "@/components/PasswordSetup";
import { ShareLinks } from "@/components/ShareLinks";
import {
  ViewType,
  ClientMessage,
  ServerMessage,
  ClientMessageType,
} from "@/constants/enums.ts";
import coffeeLogoImg from "@/assets/coffee-logo.png";
import { toast } from "sonner";
import { WS_BASE_URL } from "@/config";
import { HandlerContext, WebSocketStrategyManager } from "@/lib/strategies";

const Index = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.UPLOAD);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [shareUrls, setShareUrls] = useState<{ long: string } | null>(null);
  const [transferProgress, setTransferProgress] = useState<number>(0);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    setCurrentView(ViewType.PASSWORD);
  };

  const handleCancel = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setSelectedFile(null);
    setCurrentView(ViewType.UPLOAD);
  };

  const handleStart = async (password?: string) => {
    const toastId = toast.loading("Creating room...");
    // Create the WebSocket connection
    const ws = new WebSocket(`${WS_BASE_URL}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("Connected to WebSocket");
      // Send CreateRoom message
      const msg: ClientMessage = {
        type: ClientMessageType.CreateRoom,
        password: password,
      };
      ws.send(JSON.stringify(msg));
    };

    ws.onmessage = async (event) => {
      try {
        const message: ServerMessage = JSON.parse(event.data);
        console.log("WebSocket message received:", message);

        const context: HandlerContext = {
          setShareUrls,
          setCurrentView,
          setIsConnected,
          setTransferProgress,
          toast,
          wsRef,
          peerConnectionRef,
          dataChannelRef,
          selectedFile,
          toastId,
        };

        const strategyManager = new WebSocketStrategyManager();
        await strategyManager.handleMessage(message, context);
      } catch (e) {
        toast.dismiss(toastId);
        console.error("Failed to parse message:", e);
        toast.error("Failed to parse server message.");
      }
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      toast.dismiss(toastId);
      toast.error("Failed to connect to server.");
    };

    ws.onclose = () => {
      console.log("WebSocket connection closed");
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  };

  return (
    <div className="min-h-screen bg-gradient-cream flex flex-col">
      {/* Header */}
      {currentView !== ViewType.SHARE && (
        <header className="pt-12 pb-8 px-4">
          <div className="max-w-4xl mx-auto flex flex-col items-center gap-4">
            <img
              src={coffeeLogoImg}
              alt="Coffee Transfer"
              className="h-auto w-auto"
            />
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
      )}

      {/* Main Content */}
      <main className="flex-1 flex justify-center mt-8">
        <div className="w-2/3 max-w-4xl">
          {currentView === ViewType.UPLOAD && (
            <FileUpload onFileSelect={handleFileSelect} />
          )}

          {currentView === ViewType.PASSWORD && selectedFile && (
            <PasswordSetup
              fileName={selectedFile.name}
              onCancel={handleCancel}
              onStart={handleStart}
            />
          )}

          {currentView === ViewType.SHARE && shareUrls && (
            <ShareLinks
              longUrl={shareUrls.long}
              progress={transferProgress}
              isConnected={isConnected}
            />
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

export default Index;
