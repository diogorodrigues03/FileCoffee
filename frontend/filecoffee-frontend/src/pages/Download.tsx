import EnterPassword from "@/components/EnterPassword";
import { useRef, useState } from "react";
import coffeeLogoImg from "@/assets/coffee-logo.png";
import FileDownload from "@/components/FileDownload";
import { ViewType } from "@/constants/enums.ts";

const Download = () => {
  const [currentView, setCurrentView] = useState<ViewType>(ViewType.PASSWORD);
  const wsRef = useRef<WebSocket | null>(null);

  function handlePasswordSubmit(password: string) {
    if (password === "correct_password") {
      setCurrentView(ViewType.DOWNLOAD);
    } else {
      console.log("Incorrect password");
    }
  }

  function handleDownload() {
    //TODO: implement download logic
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
