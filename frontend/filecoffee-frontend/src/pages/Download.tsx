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
} from "@/constants/enums";
import { useParams } from "react-router-dom";
import { useRoomValidation } from "@/hooks/useRoomValidation";
import { toast } from "sonner";
import { WS_BASE_URL } from "@/config";
import {
  DownloadHandlerContext,
  DownloadStrategyManager,
} from "@/lib/strategies/download";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useWebRTC } from "@/hooks/useWebRTC";
import { useFileTransfer } from "@/hooks/useFileTransfer";
import { FileReceiver, IncomingFile } from "@/lib/transfer/receiver";

const Download = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.PASSWORD);
  const [error, setError] = useState<string | null>(null);

  // Room handling
  const { action, room_id } = useParams<{ action: string; room_id: string }>();
  const {
    isValidating,
    roomExists,
    error: validationError,
  } = useRoomValidation(action, room_id);

  // Hooks
  const { wsRef, connect: connectWs, disconnect: disconnectWs } = useWebSocket();
  const { peerConnectionRef, createConnection, setIceServers, candidateQueueRef, cleanup: cleanupWebRTC } = useWebRTC();
  const { stats, initTransfer, updateTransfer, cancelTransfer: cancelTransferLogic } = useFileTransfer();

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [incomingFile, setIncomingFile] = useState<IncomingFile | null>(null);
  const [savedToDisk, setSavedToDisk] = useState(false);
  const receiverRef = useRef<FileReceiver | null>(null);
  // The server sends an Error right before closing a socket on purpose
  // (rejected, wrong password...); the error strategy reports those.
  const lastMessageWasErrorRef = useRef(false);

  const strategyManagerRef = useRef(new DownloadStrategyManager());

  useEffect(() => {
    return () => {
      receiverRef.current?.cancel();
      disconnectWs();
      cleanupWebRTC();
    };
  }, [disconnectWs, cleanupWebRTC]);

  // Release the received file when it is replaced or the page goes away.
  useEffect(() => {
    if (!downloadUrl) return;
    return () => URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  async function handleSave() {
    // Called straight from the click so the save picker gets user activation.
    await receiverRef.current?.accept();
  }

  async function handlePasswordSubmit(password: string) {
    if (!room_id) return;

    // Reset everything for a fresh attempt
    disconnectWs();
    cleanupWebRTC();
    cancelTransferLogic();
    if (candidateQueueRef) {
        candidateQueueRef.current = [];
    }
    receiverRef.current?.cancel();
    receiverRef.current = null;
    setIncomingFile(null);
    setSavedToDisk(false);
    setDownloadUrl(null);
    setError(null);

    const toastId = toast.loading("Connecting to room...");
    lastMessageWasErrorRef.current = false;

    const handleConnectionLost = () => {
      if (lastMessageWasErrorRef.current) return;
      toast.dismiss(toastId);
      toast.dismiss("awaiting-approval");

      const state = receiverRef.current?.state;
      if (state === "done") return; // Already have the file; nothing lost.
      if (
        (state === "offered" || state === "opening" || state === "receiving") &&
        peerConnectionRef.current?.connectionState === "connected"
      ) {
        // The file comes peer-to-peer; the server isn't needed any more.
        return;
      }

      receiverRef.current?.cancel();
      receiverRef.current = null;
      cleanupWebRTC();
      cancelTransferLogic();
      setIncomingFile(null);
      setCurrentView(ViewType.PASSWORD);
      toast.error("Lost connection to the server. Try again.");
    };

    try {
      const ws = await connectWs(`${WS_BASE_URL}/ws`, handleConnectionLost);
      
      const msg: ClientMessage = {
        type: ClientMessageType.JoinRoom,
        room_id,
        password: password || undefined,
      };
      ws.send(JSON.stringify(msg));

      ws.onmessage = async (event) => {
        try {
          const message: ServerMessage = JSON.parse(event.data);
          console.log("WebSocket message received:", message);
          lastMessageWasErrorRef.current = message.type === ServerMessageType.Error;

          const context: DownloadHandlerContext = {
            setCurrentView,
            setError,
            setDownloadUrl,
            setFileName,
            toast,
            toastId,
            wsRef,
            peerConnectionRef,
            createConnection,
            setIceServers,
            candidateQueueRef,
            receiverRef,
            setIncomingFile,
            setSavedToDisk,
            initTransfer,
            updateTransfer,
            cancelTransfer: cancelTransferLogic,
          };

          await strategyManagerRef.current.handleMessage(message, context);
        } catch (e) {
          console.error("Failed to parse message:", e);
          toast.dismiss(toastId);
          toast.error("An unexpected error occurred.");
          setError("An unexpected error occurred.");
        }
      };
    } catch (error) {
      toast.dismiss(toastId);
      toast.error("Failed to connect to the server.");
      setError("Failed to connect to the server.");
    }
  }

  if (isValidating) {
    return (
      <div className="min-h-screen b-gradient-cream flex items-center justify-center">
        <p className="text-muted-foreground animate-pulse">
          Checking brew status...
        </p>
      </div>
    );
  }

  if (!roomExists) {
    return (
      <div className="min-h-screen bg-gradient-cream flex flex-col items-center justify-center gap-4">
        <h2 className="text-2xl font-bold text-red-500">
          404 - Brew Not Found!
        </h2>
        <p className="text-muted-foreground">{validationError}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-cream flex flex-col">
      {/* Header */}
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

      {/* Main Content */}
      <main className="flex-1 flex flex-col items-center mt-8">
        <div className="w-full max-w-4xl mx-auto">
          {currentView === ViewType.DOWNLOAD && (
            <FileDownload
              progress={stats?.percent || 0}
              fileName={fileName}
              downloadUrl={downloadUrl}
              incomingFile={incomingFile}
              savedToDisk={savedToDisk}
              onSave={handleSave}
            />
          )}

          {currentView === ViewType.PASSWORD && (
            <EnterPassword handlePasswordSubmit={handlePasswordSubmit} />
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
