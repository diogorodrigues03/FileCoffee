import { useState, useEffect } from "react";

interface UseRoomValidationResult {
  isValidating: boolean;
  roomExists: boolean | null;
  error: string | null;
}

export const useRoomValidation = (
  action: string | undefined,
  roomId: string | undefined,
): UseRoomValidationResult => {
  const [isValidating, setIsValidating] = useState(true);
  const [roomExists, setRoomExists] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkRoom = async () => {
      if (!roomId) {
        setRoomExists(false);
        setError("No room ID provided.");
        setIsValidating(false);
        return;
      }

      setIsValidating(true);
      setError(null);

      try {
        const response = await fetch(
          `http://localhost:3030/api/rooms/${roomId}`,
        );

        if (response.ok) {
          setRoomExists(true);
        } else {
          setRoomExists(false);
          setError("Room not found or has expired.");
        }
      } catch (err) {
        console.error("Error checking room:", err);
        setRoomExists(false); // Assume false if we can't reach the server to be safe
        setError("Unable to connect to the server.");
      } finally {
        setIsValidating(false);
      }
    };

    checkRoom();
  }, [roomId]);

  return { isValidating, roomExists, error };
};
