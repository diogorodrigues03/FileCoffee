import { useRef, useState } from "react";
import { FileUpload } from "@/components/FileUpload";
import { PasswordSetup } from "@/components/PasswordSetup";
import { ShareLinks } from "@/components/ShareLinks";
import {
  ViewType,
  ClientMessage,
  ServerMessage,
  ClientMessageType,
} from "@/constants/enums";
import coffeeLogoImg from "@/assets/coffee-logo.png";
import { toast } from "sonner";
import { WS_BASE_URL } from "@/config";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useWebRTC } from "@/hooks/useWebRTC";
import { useFileTransfer } from "@/hooks/useFileTransfer";
import { UploadStrategyManager, UploadHandlerContext } from "@/lib/strategies/upload";

const Index = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.UPLOAD);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [shareUrls, setShareUrls] = useState<{ long: string } | null>(null);
  
  const { wsRef, isConnected: isWsConnected, connect: connectWs, disconnect: disconnectWs } = useWebSocket();
  const { peerConnectionRef, dataChannelRef, createConnection, setIceServers, cleanup: cleanupWebRTC } = useWebRTC();
  const [isPeerConnected, setIsPeerConnected] = useState(false);
  
  const { stats, initTransfer, updateTransfer, cancelTransfer: cancelTransferLogic } = useFileTransfer();
  const isCanceledRef = useRef(false);
  const isOffline = !navigator.onLine;

  const strategyManagerRef = useRef(new UploadStrategyManager());

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    setCurrentView(ViewType.PASSWORD);
  };

  const handleCancel = () => {
    disconnectWs();
    cleanupWebRTC();
    cancelTransferLogic();
    setIsPeerConnected(false);
    setSelectedFile(null);
    setCurrentView(ViewType.UPLOAD);
  };

  const handleStart = async (password?: string) => {
    const toastId = toast.loading("Creating room...");
    
    try {
      const ws = await connectWs(`${WS_BASE_URL}/ws`);

      // Send CreateRoom message
      const msg: ClientMessage = {
        type: ClientMessageType.CreateRoom,
        password: password,
      };
      ws.send(JSON.stringify(msg));

      ws.onmessage = async (event) => {
        try {
          const message: ServerMessage = JSON.parse(event.data);
          console.log("WebSocket message received:", message);

          const context: UploadHandlerContext = {
            setShareUrls,
            setCurrentView,
            setIsConnected: setIsPeerConnected,
            toast,
            wsRef,
            peerConnectionRef,
            dataChannelRef,
            createConnection,
            setIceServers,
            selectedFile,
            toastId,
            initTransfer,
            updateTransfer,
            cancelTransfer: cancelTransferLogic,
            isCanceledRef
          };

          await strategyManagerRef.current.handleMessage(message, context);
        } catch (e) {
          toast.dismiss(toastId);
          console.error("Failed to parse message:", e);
        }
      };

    } catch (error) {
      toast.dismiss(toastId);
      toast.error("Failed to connect to server.");
    }
  };

  return (
    <div className="min-h-screen bg-gradient-cream flex flex-col">
      {isOffline && (
        <div className="bg-red-500 text-white text-center py-2 font-medium">
          You are currently offline. Check your internet connection.
        </div>
      )}

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
              progress={stats?.percent || 0}
              isConnected={isPeerConnected}
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
