import { useEffect, useRef, useState } from "react";
import { FileUpload } from "@/components/FileUpload";
import { PasswordSetup } from "@/components/PasswordSetup";
import { ShareLinks } from "@/components/ShareLinks";
import coffeeLogoImg from "@/assets/coffee-logo.png";

type View = "upload" | "password" | "share";

const Index = () => {
  const [currentView, setCurrentView] = useState<View>("upload");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [shareUrls, setShareUrls] = useState<{
    long: string;
    short: string;
  } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    setCurrentView("password");
  };

  const handleCancel = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setSelectedFile(null);
    setCurrentView("upload");
  };

  const handleStart = async (password?: string) => {
    // Here you would create the WebSocket connection
    // For now, we'll simulate it with mock URLs
    const ws = new WebSocket("ws://localhost:3030/ws");
    wsRef.current = ws;

    ws.onopen = () => {
      // In this case we want to create the room
      ws.send(JSON.stringify({ type: "CreateRoom" }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      console.log("WebSocket message received:", message);
      // Handle incoming messages as needed
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    ws.onclose = () => {
      wsRef.current = null;
    };

    // Mock URLs - replace with actual WebSocket URLs from your Rust backend
    const mockLongUrl = `http://localhost:8080/download/${Math.random().toString(36).substring(2, 6)}`;
    const mockShortUrl = `http://localhost:8080/download/${Math.random().toString(36).substring(2, 4)}`;

    setShareUrls({
      long: mockLongUrl,
      short: mockShortUrl,
    });

    setCurrentView("share");
  };

  return (
    <div className="min-h-screen bg-gradient-cream flex flex-col">
      {/* Header */}
      <header className="pt-12 pb-8 px-4">
        <div className="max-w-4xl mx-auto flex flex-col items-center gap-4">
          <img
            src={coffeeLogoImg}
            alt="Coffee Transfer"
            className="h-56 w-auto"
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
      <main className="flex-1 flex justify-center mt-20">
        <div className="w-full max-w-4xl">
          {currentView === "upload" && (
            <FileUpload onFileSelect={handleFileSelect} />
          )}

          {currentView === "password" && selectedFile && (
            <PasswordSetup
              fileName={selectedFile.name}
              onCancel={handleCancel}
              onStart={handleStart}
            />
          )}

          {currentView === "share" && shareUrls && (
            <ShareLinks longUrl={shareUrls.long} shortUrl={shareUrls.short} />
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
