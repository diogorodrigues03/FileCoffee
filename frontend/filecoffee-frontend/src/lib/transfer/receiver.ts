import { createSHA256, type IHasher } from "hash-wasm";
import { SignalLabelType, TransferMessageType } from "@/constants/enums";
import { FileSink, FileSinkKind, openFileSink, sanitizeFileName, SaveCancelledError } from "./fileSink";

/** Bytes written between acknowledgements to the sender (drives its send window). */
export const ACK_INTERVAL = 4 * 1024 * 1024;

export interface IncomingFile {
    name: string;
    size: number;
}

export interface ReceiverCallbacks {
    /** Metadata arrived; ask the user to accept (needs a click for the save picker). */
    onOffer(file: IncomingFile): void;
    /** The user accepted and the file is being written to `kind`. */
    onStart(file: IncomingFile, kind: FileSinkKind): void;
    onProgress(bytes: number): void;
    /** Verified. `url` is a download link, or null when already saved to disk. */
    onComplete(file: IncomingFile, url: string | null): void;
    onError(message: string): void;
    onCanceledByPeer(): void;
}

export type ReceiverState = "waiting" | "offered" | "opening" | "receiving" | "done" | "failed";

/**
 * Receiving side of one transfer over a data channel. Messages are processed
 * strictly in order through one promise queue, because disk writes are async
 * and the channel keeps delivering while they run.
 */
export class FileReceiver {
    private _state: ReceiverState = "waiting";
    private file: IncomingFile | null = null;
    private sink: FileSink | null = null;
    private hasher: IHasher | null = null;
    private received = 0;
    private lastAck = 0;
    private queue: Promise<void> = Promise.resolve();

    constructor(
        private readonly dc: RTCDataChannel,
        private readonly cb: ReceiverCallbacks
    ) {
        dc.binaryType = "arraybuffer";
        dc.onmessage = (event) => {
            this.queue = this.queue
                .then(() => this.handle(event.data))
                .catch((error) => {
                    console.error("Transfer failed:", error);
                    return this.fail("Failed to save the file.");
                });
        };
    }

    get state(): ReceiverState {
        return this._state;
    }

    /** Called from the user's click. Resolves false if they dismissed the save dialog. */
    async accept(): Promise<boolean> {
        if (this._state !== "offered" || !this.file) return false;
        this._state = "opening";

        // openFileSink must be the first await so the picker keeps the click's activation.
        try {
            this.sink = await openFileSink(this.file.name);
        } catch (error) {
            if (error instanceof SaveCancelledError) {
                this._state = "offered";
                return false;
            }
            await this.fail("Couldn't open a place to save the file.");
            return false;
        }
        if (this._state !== "opening") {
            // Cancelled while the save dialog was open.
            await this.sink.abort();
            return false;
        }

        this.hasher = await createSHA256();
        this.hasher.init();
        this._state = "receiving";
        this.cb.onStart(this.file, this.sink.kind);
        this.send({ type: TransferMessageType.Ready });
        return true;
    }

    /** Local cancel (peer left, page closed). Does not notify the peer. */
    async cancel() {
        if (this._state === "done" || this._state === "failed") return;
        this._state = "failed";
        await this.sink?.abort();
    }

    private async handle(data: unknown) {
        if (this._state === "done" || this._state === "failed") return;

        if (data instanceof ArrayBuffer) {
            await this.handleChunk(data);
            return;
        }
        if (typeof data !== "string") return;

        let msg: { type?: unknown; [key: string]: unknown };
        try {
            msg = JSON.parse(data);
        } catch {
            return;
        }

        switch (msg.type) {
            case TransferMessageType.Metadata:
                return this.handleMetadata(msg);
            case TransferMessageType.Done:
                return this.handleDone(msg);
            case SignalLabelType.Cancel:
                await this.cancel();
                this.cb.onCanceledByPeer();
                return;
        }
    }

    private handleMetadata(msg: Record<string, unknown>) {
        if (this._state !== "waiting") {
            return this.fail("The sender started a second file mid-transfer.");
        }
        const size = msg.fileSize;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
            return this.fail("The sender announced an invalid file size.");
        }
        this.file = { name: sanitizeFileName(msg.fileName), size };
        this._state = "offered";
        this.cb.onOffer(this.file);
    }

    private async handleChunk(chunk: ArrayBuffer) {
        if (this._state !== "receiving" || !this.file || !this.sink || !this.hasher) {
            return this.fail("The sender sent data before the transfer was accepted.");
        }
        if (this.received + chunk.byteLength > this.file.size) {
            return this.fail("The sender sent more data than it announced.");
        }

        this.hasher.update(new Uint8Array(chunk));
        await this.sink.write(chunk);
        this.received += chunk.byteLength;
        this.cb.onProgress(chunk.byteLength);

        if (this.received - this.lastAck >= ACK_INTERVAL || this.received === this.file.size) {
            this.lastAck = this.received;
            this.send({ type: TransferMessageType.Ack, bytes: this.received });
        }
    }

    private async handleDone(msg: Record<string, unknown>) {
        if (this._state !== "receiving" || !this.file || !this.sink || !this.hasher) {
            return this.fail("The sender finished a transfer that never started.");
        }
        if (this.received !== this.file.size) {
            return this.fail("The transfer ended before the whole file arrived.");
        }
        const actual = this.hasher.digest("hex");
        if (typeof msg.sha256 !== "string" || msg.sha256.toLowerCase() !== actual) {
            return this.fail("File integrity check failed (SHA-256 mismatch).");
        }

        const url = await this.sink.close();
        this._state = "done";
        this.send({ type: SignalLabelType.Progress, percent: 100 });
        this.cb.onComplete(this.file, url);
    }

    private async fail(message: string) {
        if (this._state === "done" || this._state === "failed") return;
        this._state = "failed";
        await this.sink?.abort();
        this.send({ type: SignalLabelType.Cancel });
        this.cb.onError(message);
    }

    private send(msg: object) {
        if (this.dc.readyState === "open") {
            this.dc.send(JSON.stringify(msg));
        }
    }
}
