import { Msg } from "../message";

// ---- Strategy config (discriminated union) ----

export type RoundRobinConfig    = { strategy: 'roundRobin' };
export type RandomConfig         = { strategy: 'random' };
export type LeastLoadConfig      = { strategy: 'leastLoad' };
export type ConsistentHashConfig = {
    strategy: 'consistentHash';
    hashKey?: 'openId' | 'zoneId' | 'gid';   // default 'gid'
};
export type LbStrategyConfig =
    | RoundRobinConfig | RandomConfig
    | LeastLoadConfig  | ConsistentHashConfig;

// ---- Interface ----

export interface ILoadBalancer {
    selectWorkerIndex(msg: Msg, workerCount: number): number;
    onMessageSent(workerIndex: number): void;
    onMessageResolved(workerIndex: number): void;
    resetIndex(workerIndex: number): void;
}

// ---- Round Robin ----

export class RoundRobinLB implements ILoadBalancer {
    private index = 0;
    selectWorkerIndex(_msg: Msg, workerCount: number): number {
        this.index = (this.index + 1) % workerCount;
        return this.index;
    }
    onMessageSent(_i: number) {}
    onMessageResolved(_i: number) {}
    resetIndex(_i: number) {}
}

// ---- Random ----

export class RandomLB implements ILoadBalancer {
    selectWorkerIndex(_msg: Msg, workerCount: number): number {
        return Math.floor(Math.random() * workerCount);
    }
    onMessageSent(_i: number) {}
    onMessageResolved(_i: number) {}
    resetIndex(_i: number) {}
}

// ---- Least Load (counting on main thread, no cross-thread communication needed) ----

export class LeastLoadLB implements ILoadBalancer {
    private pending: number[];
    constructor(workerCount: number) {
        this.pending = new Array(workerCount).fill(0);
    }
    selectWorkerIndex(_msg: Msg, _workerCount: number): number {
        return this.pending.indexOf(Math.min(...this.pending));
    }
    onMessageSent(i: number)     { this.pending[i]++; }
    onMessageResolved(i: number) { if (this.pending[i] > 0) this.pending[i]--; }
    resetIndex(i: number)        { this.pending[i] = 0; }
}

// ---- Consistent Hash (djb2, pure TS implementation, no external dependencies) ----

export class ConsistentHashLB implements ILoadBalancer {
    private hashKey: 'openId' | 'zoneId' | 'gid';
    constructor(cfg: ConsistentHashConfig) {
        this.hashKey = cfg.hashKey ?? 'gid';
    }
    private djb2(s: string): number {
        let h = 5381;
        for (let i = 0; i < s.length; i++)
            h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h;
    }
    selectWorkerIndex(msg: Msg, workerCount: number): number {
        const key = this.hashKey === 'gid'
            ? String(msg.head.gid ?? 0)
            : this.hashKey === 'zoneId'
                ? String(msg.head.zoneId ?? 0) : (msg.head.openId ?? '');
        return this.djb2(key) % workerCount;
    }
    onMessageSent(_i: number) {}
    onMessageResolved(_i: number) {}
    resetIndex(_i: number) {}
}

// ---- Factory ----

export function createLoadBalancer(cfg: LbStrategyConfig, workerCount: number): ILoadBalancer {
    switch (cfg.strategy) {
        case 'roundRobin':     return new RoundRobinLB();
        case 'random':         return new RandomLB();
        case 'leastLoad':      return new LeastLoadLB(workerCount);
        case 'consistentHash': return new ConsistentHashLB(cfg);
    }
}
