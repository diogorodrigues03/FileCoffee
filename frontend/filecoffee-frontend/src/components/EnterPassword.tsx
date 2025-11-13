import { useState } from "react";
import { Lock, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const EnterPassword = ({ handlePasswordSubmit }) => {
  const [password, setPassword] = useState("");

  return (
    <div className="flex flex-col items-center mx-auto gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500 w-full max-w-md">
      <div className="bg-card p-8 rounded-2xl shadow-medium border border-border w-full">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-accent/10">
            <Lock className="h-6 w-6 text-accent" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-foreground">
              LOCKED FILE
            </h2>
            <p className="text-sm text-muted-foreground">
              This file is protected. Please enter the password to proceed.
            </p>
          </div>
        </div>

        <div className="space-y-2 mb-8">
          <Label htmlFor="password" className="text-foreground">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            placeholder="Enter a password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="bg-background border-border focus:border-accent transition-smooth"
          />
        </div>

        <div className="flex gap-3">
          <Button
            onClick={() => handlePasswordSubmit(password)}
            className="flex-1 bg-gradient-coffee text-primary-foreground shadow-medium hover:opacity-90 transition-smooth"
          >
            Start Download
          </Button>
        </div>
      </div>
    </div>
  );
};

export default EnterPassword;
