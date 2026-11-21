import { useRef, useState } from "react";
import { FileUpload } from "@/components/FileUpload";
import { PasswordSetup } from "@/components/PasswordSetup";
import { ShareLinks } from "@/components/ShareLinks";
import {
  ViewType,
  ClientMessage,
  ServerMessage,
  ServerMessageType,
  ClientMessageType,
} from "@/constants/enums";
import coffeeLogoImg from "@/assets/coffee-logo.png";
import { toast } from "sonner";
import { WS_BASE_URL } from "@/config";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useWebRTC } from "@/hooks/useWebRTC";
import { useFileTransfer } from "@/hooks/useFileTransfer";
import {
  UploadStrategyManager,
  UploadHandlerContext,
  APPROVAL_TOAST_ID,
  LINK_LOST_TOAST_ID,
} from "@/lib/strategies/upload";

const Index = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.UPLOAD);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [shareUrls, setShareUrls] = useState<{ long: string } | null>(null);
  
  const { wsRef, isConnected: isWsConnected, connect: connectWs, disconnect: disconnectWs } = useWebSocket();
  const { peerConnectionRef, dataChannelRef, createConnection, setIceServers, cleanup: cleanupWebRTC } = useWebRTC();
  const [isPeerConnected, setIsPeerConnected] = useState(false);
  
  const { stats, initTransfer, updateTransfer, cancelTransfer: cancelTransferLogic } = useFileTransfer();
  const isCanceledRef = useRef(false);
  // The server sends an Error right before closing a socket on purpose
  // (room expired, too many attempts...); the error strategy reports those.
  const lastMessageWasErrorRef = useRef(false);
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
    toast.dismiss(LINK_LOST_TOAST_ID);
    const toastId = toast.loading("Creating room...");
    lastMessageWasErrorRef.current = false;

    const handleConnectionLost = () => {
      if (lastMessageWasErrorRef.current) return;
      toast.dismiss(toastId);
      toast.dismiss(APPROVAL_TOAST_ID);

      if (dataChannelRef.current?.readyState === "open") {
        // The peer-to-peer connection doesn't need the server any more.
        toast.warning(
          "Lost connection to the server. Your current receiver is unaffected, but the link won't work for anyone new.",
          { duration: Infinity, id: LINK_LOST_TOAST_ID }
        );
        return;
      }

      cleanupWebRTC();
      cancelTransferLogic();
      setIsPeerConnected(false);
      setShareUrls(null);
      setCurrentView(ViewType.PASSWORD);
      toast.error(
        "Lost connection to the server, so your link stopped working. Start again to get a new one.",
        { duration: Infinity, id: LINK_LOST_TOAST_ID }
      );
    };

    try {
      const ws = await connectWs(`${WS_BASE_URL}/ws`, handleConnectionLost);

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
          lastMessageWasErrorRef.current = message.type === ServerMessageType.Error;

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
