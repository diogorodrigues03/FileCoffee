import { Lock, LucideCircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Progress } from "@/components/ui/progress.tsx";

interface FileDownloadProps {
  progress: number;
  fileName: string;
  downloadUrl: string | null;
}

const FileDownload = ({
  progress,
  fileName,
  downloadUrl,
}: FileDownloadProps) => {
  return (
    <div className="flex flex-col items-center mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500 w-full max-w-md">
      <div className="bg-card p-8 rounded-2xl shadow-medium border border-border w-full">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-accent/10">
            <LucideCircleCheck className="h-6 w-6 text-accent" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-foreground">
              {fileName || "Waiting for file..."}
            </h2>
          </div>
        </div>

        {downloadUrl ? (
          <div className="flex items-center justify-center mb-6">
            <a href={downloadUrl} download={fileName}>
              <Button className="h-12 w-28 bg-gradient-coffee">Download</Button>
            </a>
          </div>
        ) : (
          <div className="mb-6 text-center text-sm text-muted-foreground">
            Transferring file... {progress.toFixed(0)}%
          </div>
        )}

        <div>
          <Progress value={progress} />
        </div>
      </div>
    </div>
  );
};

export default FileDownload;
