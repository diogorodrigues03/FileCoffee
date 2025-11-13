import { useCallback, useState } from "react";
import { Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileUploadProps {
  onFileSelect: (file: File) => void;
}

export const FileUpload = ({ onFileSelect }: FileUploadProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setSelectedFile(files[0]);
    }
  }, []);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      setSelectedFile(files[0]);
    }
  }, []);

  const handleContinue = useCallback(() => {
    if (selectedFile) {
      onFileSelect(selectedFile);
    }
  }, [selectedFile, onFileSelect]);

  const handleRemove = useCallback(() => {
    setSelectedFile(null);
  }, []);

  if (selectedFile) {
    return (
      <div className="flex flex-col items-center gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="bg-card p-6 rounded-2xl shadow-medium border border-border w-full max-w-md">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-muted-foreground mb-1">Selected file</p>
              <p className="text-foreground font-medium truncate">{selectedFile.name}</p>
              <p className="text-xs text-muted-foreground mt-1">
                {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRemove}
              className="hover:bg-destructive/10 hover:text-destructive transition-smooth shrink-0"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
        <Button 
          onClick={handleContinue}
          size="lg"
          className="bg-gradient-coffee text-primary-foreground shadow-medium hover:opacity-90 transition-smooth px-12"
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          relative border-2 border-dashed rounded-3xl p-12 w-full max-w-2xl
          transition-all duration-300 cursor-pointer
          ${isDragging 
            ? 'border-accent bg-accent/5 scale-105' 
            : 'border-border bg-card/50 hover:border-accent/50 hover:bg-accent/5'
          }
        `}
      >
        <input
          type="file"
          onChange={handleFileInput}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          id="file-input"
        />
        <label htmlFor="file-input" className="flex flex-col items-center gap-4 cursor-pointer">
          <div className="p-6 rounded-full bg-gradient-coffee shadow-medium">
            <Upload className="h-12 w-12 text-primary-foreground" />
          </div>
          <div className="text-center">
            <p className="text-xl font-semibold text-foreground mb-2">
              Drop your file here
            </p>
            <p className="text-muted-foreground">
              or click to browse from your computer
            </p>
          </div>
        </label>
      </div>
    </div>
  );
};
