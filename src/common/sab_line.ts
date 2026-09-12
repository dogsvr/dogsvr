import {
    SabRingWriter,
    SabRingReader,
    makeSabRing,
    openSabRing,
    toPowerOfTwo,
} from "./sab_ring";
import { SabPump } from "./sab_pump";

/** Worst-case UTF-8 expansion per JS char, for sizing the claim before writing. */
const MAX_UTF8_PER_CHAR = 3;

export function makeLineSab(dataBytes: number): SharedArrayBuffer {
    return makeSabRing(toPowerOfTwo(dataBytes));
}

export class SabLineWriter extends SabRingWriter {
    /**
     * The claim must cover the worst case: Buffer.write truncates silently at a codepoint
     * boundary when it runs out of room, dropping characters with no error.
     */
    tryWrite(line: string, level: number): boolean {
        const off = this.claim(line.length * MAX_UTF8_PER_CHAR);
        if (off < 0) return false;
        const len = this.buf.write(line, off, "utf8");
        if (len <= 0) return false;
        this.commit(level, len);
        return true;
    }
}

/**
 * Receives a slice of the ring. The bytes are valid only for the duration of the call —
 * the producer reuses that memory once HEAD advances, so a consumer that retains the data
 * (sonic-boom keeps the reference it is handed) must copy it out first.
 */
export type OnRecordFn = (buf: Buffer, off: number, len: number, level: number) => void;

export class SabLineReader {
    private readonly pump: SabPump;
    private readonly buf: Buffer;

    constructor(sab: SharedArrayBuffer, onRecord: OnRecordFn) {
        const view = openSabRing(sab);
        this.buf = view.buf;
        this.pump = new SabPump(
            new SabRingReader(sab),
            view.state,
            (off, len, meta) => onRecord(this.buf, off, len, meta),
            // Logs tolerate ~1ms of latency; in exchange the producer never pays notify.
            "poll",
        );
    }

    start(): void {
        this.pump.start();
    }

    stop(): void {
        this.pump.stop();
    }

    /** Best-effort synchronous drain of everything currently visible. */
    drainSync(): void {
        this.pump.drainSync();
    }
}
