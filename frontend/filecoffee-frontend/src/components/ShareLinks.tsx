import { useState } from "react";
import { Copy, Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";

interface ShareLinksProps {
  longUrl: string;
  progress: number;
  isConnected: boolean;
}

export const ShareLinks = ({
  longUrl,
  progress,
  isConnected,
}: ShareLinksProps) => {
  const [copiedLong, setCopiedLong] = useState(false);

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedLong(true);
      setTimeout(() => setCopiedLong(false), 2000);
      toast.success("Link copied to clipboard!");
    } catch (error) {
      toast.error("Failed to copy link");
    }
  };

  return (
    <div className="flex flex-col items-center gap-8 mx-auto mt-20 animate-in fade-in slide-in-from-bottom-4 duration-500 w-full max-w-2xl">
      <div className="text-center">
        <div className="inline-flex items-center justify-center p-4 rounded-full bg-accent/10 mb-4">
          <Check className="h-8 w-8 text-accent" />
        </div>
        <h2 className="text-2xl font-bold text-foreground mb-2">
          Transfer Ready!
        </h2>
        <p className="text-muted-foreground">
          Share these links to start transferring your file
        </p>
      </div>

      <div className="bg-card p-8 rounded-2xl shadow-medium border border-border w-full space-y-6">
        <div className="space-y-2">
          <Label
            htmlFor="long-url"
            className="flex items-center gap-2 text-foreground"
          >
            <Link2 className="h-4 w-4" />
            Full URL
          </Label>
          <div className="flex gap-2">
            <Input
              id="long-url"
              value={longUrl}
              readOnly
              className="bg-background border-border font-mono text-sm"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => handleCopy(longUrl)}
              className="shrink-0 border-border hover:bg-secondary transition-smooth"
            >
              {copiedLong ? (
                <Check className="h-4 w-4 text-accent" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="pt-4 border-t border-border">
          {!isConnected && (
            <p className="text-sm text-muted-foreground text-center">
              Waiting for peer to join...
            </p>
          )}

          {isConnected && progress === 0 && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground text-center">
                Peer connected. Preparing transfer...
              </p>
              <Progress value={0} />
            </div>
          )}

          {progress > 0 && progress < 100 && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground text-center">
                Transferring... {progress.toFixed(0)}%
              </p>
              <Progress value={progress} />
            </div>
          )}

          {progress === 100 && (
            <div className="space-y-2">
              <p className="text-sm text-green-600 font-medium text-center">
                Transfer Complete!
              </p>
              <Progress
                value={100}
                className="bg-green-100 [&>div]:bg-green-600"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
