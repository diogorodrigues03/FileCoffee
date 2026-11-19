import { createSHA256 } from "hash-wasm";
import { SignalLabelType, TransferMessageType } from "@/constants/enums";

const CHUNK_SIZE = 256 * 1024;
/** Pause when this much is queued in the data channel... */
const HIGH_WATER_MARK = 8 * 1024 * 1024;
/** ...and resume once it drains below this. */
const LOW_WATER_MARK = 1024 * 1024;
/**
 * Max bytes sent but not yet acknowledged as written by the receiver. Keeps a
 * receiver with a slow disk from buffering an unbounded amount in memory.
 */
const SEND_WINDOW = 32 * 1024 * 1024;

export interface SenderCallbacks {
    /** The receiver accepted; bytes start flowing. */
    onStart(size: number): void;
    onProgress(bytes: number): void;
    /** The receiver verified the SHA-256 and saved the file. */
    onComplete(): void;
    onCanceledByPeer(): void;
    onError(message: string): void;
}

/**
 * Sending side of one transfer. Reads the file one chunk at a time and hashes
 * as it goes, so neither the file nor its hash input is ever fully in memory;
 * the SHA-256 goes out in the final Done message.
 */
export class FileSender {
    private started = false;
    private stopped = false;
    private acked = 0;
    private wake: (() => void) | null = null;

    constructor(
        private readonly dc: RTCDataChannel,
        private readonly file: File,
        private readonly cb: SenderCallbacks
    ) {
        dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
        dc.onbufferedamountlow = () => this.wakeUp();
        dc.onclose = () => {
            this.stopped = true;
            this.wakeUp();
        };
        dc.onmessage = (event) => this.handle(event.data);
    }

    /** Announces the file. Nothing else is sent until the receiver replies Ready. */
    offer() {
        this.dc.send(
            JSON.stringify({
                type: TransferMessageType.Metadata,
                fileName: this.file.name,
                fileSize: this.file.size,
            })
        );
    }

    /** Local cancel: stop sending and tell the receiver. */
    cancel() {
        if (this.stopped) return;
        this.stopped = true;
        this.wakeUp();
        if (this.dc.readyState === "open") {
            this.dc.send(JSON.stringify({ type: SignalLabelType.Cancel }));
        }
    }

    private handle(data: unknown) {
        if (typeof data !== "string") return;
        let msg: { type?: unknown; [key: string]: unknown };
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }

        switch (msg.type) {
            case TransferMessageType.Ready:
                if (!this.started && !this.stopped) {
                    this.started = true;
                    this.stream().catch((error) => {
                        console.error("Error sending file:", error);
                        this.stopped = true;
                        this.cb.onError("Error sending file data.");
                    });
                }
                return;
            case TransferMessageType.Ack:
                if (typeof msg.bytes === "number" && msg.bytes > this.acked) {
                    this.acked = msg.bytes;
                    this.wakeUp();
                }
                return;
            case SignalLabelType.Progress:
                if (msg.percent === 100) this.cb.onComplete();
                return;
            case SignalLabelType.Cancel:
                this.stopped = true;
                this.wakeUp();
                this.cb.onCanceledByPeer();
                return;
        }
    }

    private async stream() {
        const hasher = await createSHA256();
        hasher.init();
        this.cb.onStart(this.file.size);

        let sent = 0;
        while (sent < this.file.size) {
            if (this.stopped) return;

            if (
                this.dc.bufferedAmount > HIGH_WATER_MARK ||
                sent - this.acked >= SEND_WINDOW
            ) {
                await new Promise<void>((resolve) => (this.wake = resolve));
                continue;
            }

            const chunk = await this.file.slice(sent, sent + CHUNK_SIZE).arrayBuffer();
            if (this.stopped) return;
            hasher.update(new Uint8Array(chunk));
            this.dc.send(chunk);
            sent += chunk.byteLength;
            this.cb.onProgress(chunk.byteLength);
        }

        if (this.stopped) return;
        this.dc.send(
            JSON.stringify({ type: TransferMessageType.Done, sha256: hasher.digest("hex") })
        );
    }

    private wakeUp() {
        const wake = this.wake;
        this.wake = null;
        wake?.();
    }
}
