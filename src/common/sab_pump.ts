import {
    SabRingReader,
    OnRecordFn,
    TAIL_INDEX,
    CSTATE_INDEX,
    AWAKE,
    PARKED,
    waitAsync,
} from "./sab_ring";

/**
 * "park": block as soon as the ring is empty — lowest latency, but each wakeup costs
 * the producer a ~6us Atomics.notify.
 * "poll": stay AWAKE on a 1ms timer while traffic flows, so the producer elides notify
 * entirely. Costs up to POLL_MS of delivery latency; only for consumers where that is invisible.
 */
export type PumpMode = "park" | "poll";

const POLL_MS = 1;
const IDLE_POLLS_BEFORE_PARK = 5;

/** The one park/wake loop. Duplicating the Dekker handshake per encoding is how lost wakeups get in. */
export class SabPump {
    private readonly reader: SabRingReader;
    private readonly state: Int32Array;
    private readonly onRecord: OnRecordFn;
    private readonly mode: PumpMode;
    private readonly loopBound: () => void;
    private stopped = true;
    private idlePolls = 0;

    constructor(reader: SabRingReader, state: Int32Array, onRecord: OnRecordFn, mode: PumpMode) {
        this.reader = reader;
        this.state = state;
        this.onRecord = onRecord;
        this.mode = mode;
        this.loopBound = () => this.loop();
    }

    start(): void {
        if (!this.stopped) return;
        this.stopped = false;
        this.idlePolls = 0;
        this.loop();
    }

    /**
     * A stop()/start() pair can leave a stale loop chain running alongside the new one
     * (an outstanding waitAsync still resolves). Harmless only because drain() owns the
     * single head cursor, so the extra chain finds nothing — revisit if that changes.
     */
    stop(): void {
        this.stopped = true;
        // Stay AWAKE so a producer racing stop() does not notify a dead reader.
        Atomics.store(this.state, CSTATE_INDEX, AWAKE);
    }

    drainSync(): number {
        return this.reader.drain(this.onRecord);
    }

    private loop(): void {
        if (this.stopped) return;
        if (this.reader.drain(this.onRecord) > 0) {
            this.idlePolls = 0;
            setImmediate(this.loopBound);
            return;
        }
        if (this.mode === "poll" && ++this.idlePolls < IDLE_POLLS_BEFORE_PARK) {
            setTimeout(this.loopBound, POLL_MS);
            return;
        }
        this.park();
    }

    private park(): void {
        const {state} = this;
        const tail = Atomics.load(state, TAIL_INDEX);
        Atomics.store(state, CSTATE_INDEX, PARKED); // seq-cst store...
        if (Atomics.load(state, TAIL_INDEX) !== tail) { // ...then load: Dekker, no lost wakeup
            this.resume();
            return;
        }
        const res = waitAsync(state, TAIL_INDEX, tail);
        if (!res.async) {
            this.resume();
            return;
        }
        (res.value as Promise<"ok" | "not-equal" | "timed-out">).then(() => {
            Atomics.store(state, CSTATE_INDEX, AWAKE);
            this.idlePolls = 0;
            if (!this.stopped) this.loop();
        });
    }

    private resume(): void {
        Atomics.store(this.state, CSTATE_INDEX, AWAKE);
        this.idlePolls = 0;
        setImmediate(this.loopBound);
    }
}
