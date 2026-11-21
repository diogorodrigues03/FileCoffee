import { LucideCircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Progress } from "@/components/ui/progress.tsx";
import { getFileSize } from "@/lib/utils";
import type { IncomingFile } from "@/lib/transfer/receiver";

interface FileDownloadProps {
  progress: number;
  fileName: string;
  downloadUrl: string | null;
  /** Set while the sender's offer waits for the user to pick where to save. */
  incomingFile: IncomingFile | null;
  /** The file was written straight to the location the user picked. */
  savedToDisk: boolean;
  onSave: () => void;
}

const FileDownload = ({
  progress,
  fileName,
  downloadUrl,
  incomingFile,
  savedToDisk,
  onSave,
}: FileDownloadProps) => {
  let body;
  if (incomingFile) {
    body = (
      <div className="flex flex-col items-center gap-3 mb-6">
        <p className="text-sm text-muted-foreground">
          {getFileSize(incomingFile)} · choose where to save it to start the transfer
        </p>
        <Button className="h-12 w-28 bg-gradient-coffee" onClick={onSave}>
          Save file
        </Button>
      </div>
    );
  } else if (downloadUrl) {
    body = (
      <div className="flex items-center justify-center mb-6">
        <a href={downloadUrl} download={fileName}>
          <Button className="h-12 w-28 bg-gradient-coffee">Download</Button>
        </a>
      </div>
    );
  } else if (savedToDisk) {
    body = (
      <div className="mb-6 text-center text-sm text-muted-foreground">
        Saved and verified.
      </div>
    );
  } else {
    body = (
      <div className="mb-6 text-center text-sm text-muted-foreground">
        {fileName ? `Transferring file... ${progress.toFixed(0)}%` : "Waiting for the sender..."}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500 w-full max-w-md">
      <div className="bg-card p-8 rounded-2xl shadow-medium border border-border w-full">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-accent/10">
            <LucideCircleCheck className="h-6 w-6 text-accent" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-foreground break-all">
              {fileName || "Waiting for file..."}
            </h2>
          </div>
        </div>

        {body}

        <div>
          <Progress value={savedToDisk || downloadUrl ? 100 : progress} />
        </div>
      </div>
    </div>
  );
};

export default FileDownload;
