import { useState } from "react";
import { Lock, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface PasswordSetupProps {
  fileName: string;
  onCancel: () => void;
  onStart: (password?: string) => void;
}

export const PasswordSetup = ({ fileName, onCancel, onStart }: PasswordSetupProps) => {
  const [password, setPassword] = useState("");

  const handleStart = () => {
    onStart(password.trim() || undefined);
  };

  return (
    <div className="flex flex-col items-center mx-auto gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500 w-full max-w-md">
      <div className="bg-card p-8 rounded-2xl shadow-medium border border-border w-full">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-accent/10">
            <Lock className="h-6 w-6 text-accent" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-foreground">Optional Security</h2>
            <p className="text-sm text-muted-foreground">Protect your transfer with a password</p>
          </div>
        </div>

        <div className="mb-6">
          <p className="text-sm text-muted-foreground mb-2">File to share:</p>
          <p className="text-foreground font-medium truncate bg-secondary/50 px-3 py-2 rounded-lg">
            {fileName}
          </p>
        </div>

        <div className="space-y-2 mb-8">
          <Label htmlFor="password" className="text-foreground">
            Password (optional)
          </Label>
          <Input
            id="password"
            type="password"
            placeholder="Enter a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-background border-border focus:border-accent transition-smooth"
          />
          <p className="text-xs text-muted-foreground">
            Leave empty for no password protection
          </p>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1 border-border hover:bg-secondary transition-smooth"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <Button
            onClick={handleStart}
            className="flex-1 bg-gradient-coffee text-primary-foreground shadow-medium hover:opacity-90 transition-smooth"
          >
            Start Transfer
          </Button>
        </div>
      </div>
    </div>
  );
};