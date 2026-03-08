import { Msg } from "../message";

// ---- 策略配置（判别联合类型）----

export type RoundRobinConfig    = { strategy: 'roundRobin' };
export type RandomConfig         = { strategy: 'random' };
export type LeastLoadConfig      = { strategy: 'leastLoad' };
export type ConsistentHashConfig = {
    strategy: 'consistentHash';
    hashKey?: 'openId' | 'zoneId';   // 默认 'openId'
};
export type LbStrategyConfig =
    | RoundRobinConfig | RandomConfig
    | LeastLoadConfig  | ConsistentHashConfig;

// ---- 接口 ----

export interface ILoadBalancer {
    selectWorkerIndex(msg: Msg, workerCount: number): number;
    onMessageSent(workerIndex: number): void;
    onMessageResolved(workerIndex: number): void;
}

// ---- 轮询 ----

export class RoundRobinLB implements ILoadBalancer {
    private index = 0;
    selectWorkerIndex(_msg: Msg, workerCount: number): number {
        this.index = (this.index + 1) % workerCount;
        return this.index;
    }
    onMessageSent(_i: number) {}
    onMessageResolved(_i: number) {}
}

// ---- 随机 ----

export class RandomLB implements ILoadBalancer {
    selectWorkerIndex(_msg: Msg, workerCount: number): number {
        return Math.floor(Math.random() * workerCount);
    }
    onMessageSent(_i: number) {}
    onMessageResolved(_i: number) {}
}

// ---- 最少负载（主线程侧计数，无需跨线程通信）----

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
}

// ---- 一致性哈希（djb2，纯 TS 实现，无外部依赖）----

export class ConsistentHashLB implements ILoadBalancer {
    private hashKey: 'openId' | 'zoneId';
    constructor(cfg: ConsistentHashConfig) {
        this.hashKey = cfg.hashKey ?? 'openId';
    }
    private djb2(s: string): number {
        let h = 5381;
        for (let i = 0; i < s.length; i++)
            h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        return h;
    }
    selectWorkerIndex(msg: Msg, workerCount: number): number {
        const key = this.hashKey === 'zoneId'
            ? String(msg.head.zoneId) : msg.head.openId;
        return this.djb2(key) % workerCount;
    }
    onMessageSent(_i: number) {}
    onMessageResolved(_i: number) {}
}

// ---- 工厂 ----

export function createLoadBalancer(cfg: LbStrategyConfig, workerCount: number): ILoadBalancer {
    switch (cfg.strategy) {
        case 'roundRobin':     return new RoundRobinLB();
        case 'random':         return new RandomLB();
        case 'leastLoad':      return new LeastLoadLB(workerCount);
        case 'consistentHash': return new ConsistentHashLB(cfg);
    }
}
