import { useState } from "react";
import { Copy, Check, Link2, Link } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

interface ShareLinksProps {
  longUrl: string;
  shortUrl: string;
}

export const ShareLinks = ({ longUrl, shortUrl }: ShareLinksProps) => {
  const [copiedLong, setCopiedLong] = useState(false);
  const [copiedShort, setCopiedShort] = useState(false);

  const handleCopy = async (text: string, type: 'long' | 'short') => {
    try {
      await navigator.clipboard.writeText(text);
      if (type === 'long') {
        setCopiedLong(true);
        setTimeout(() => setCopiedLong(false), 2000);
      } else {
        setCopiedShort(true);
        setTimeout(() => setCopiedShort(false), 2000);
      }
      toast.success("Link copied to clipboard!");
    } catch (error) {
      toast.error("Failed to copy link");
    }
  };

  return (
    <div className="flex flex-col items-center gap-8 mx-auto animate-in fade-in slide-in-from-bottom-4 duration-500 w-full max-w-2xl">
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
          <Label htmlFor="long-url" className="flex items-center gap-2 text-foreground">
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
              onClick={() => handleCopy(longUrl, 'long')}
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

        <div className="space-y-2">
          <Label htmlFor="short-url" className="flex items-center gap-2 text-foreground">
            <Link className="h-4 w-4" />
            Short URL
          </Label>
          <div className="flex gap-2">
            <Input
              id="short-url"
              value={shortUrl}
              readOnly
              className="bg-background border-border font-mono text-sm"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={() => handleCopy(shortUrl, 'short')}
              className="shrink-0 border-border hover:bg-secondary transition-smooth"
            >
              {copiedShort ? (
                <Check className="h-4 w-4 text-accent" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        <div className="pt-4 border-t border-border">
          <p className="text-sm text-muted-foreground text-center">
            These links are active and ready to receive connections
          </p>
        </div>
      </div>
    </div>
  );
};