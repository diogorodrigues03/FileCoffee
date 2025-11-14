import { Lock, LucideCircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { useEffect, useState } from "react";

const FileDownload = () => {
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Place-holder effect for testing
  useEffect(() => {
    const totalDuration = 10_000;
    const intervalMs = 100;
    const increment = 100 / (totalDuration / intervalMs);

    let current = 0;
    const interval = setInterval(() => {
      current += increment;
      if (current >= 100) {
        setDownloadProgress(100);
        clearInterval(interval);
      } else {
        setDownloadProgress(current);
      }
    }, intervalMs);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500 w-full max-w-md">
      <div className="bg-card p-8 rounded-2xl shadow-medium border border-border w-full">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-accent/10">
            <LucideCircleCheck className="h-6 w-6 text-accent" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-foreground">
              Download Ready
            </h2>
          </div>
        </div>
        <div className="flex items-center justify-center mb-6">
          <Button className="h-12 w-28 bg-gradient-coffee">Download</Button>
        </div>
        <div>
          <Progress value={downloadProgress} />
        </div>
      </div>
    </div>
  );
};

export default FileDownload;
