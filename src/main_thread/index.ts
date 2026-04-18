import { BaseCL } from "./cl_base";
import { Msg } from "../message";
import { infoLog, warnLog } from "../logger";
import { SvrConfig, ServerCore, createServerCore } from "./server_core";
import { createHotUpdateStrategy } from "./hot_update";
import { loadMainThreadConfig } from "./config";
import "./pm2"

let core: ServerCore | null = null;

export function getConnLayer(clName: string): BaseCL {
    return core!.svrCfg.clMap[clName];
}

export async function startServer(cfg: SvrConfig): Promise<void>;
export async function startServer(configPath: string): Promise<void>;
export async function startServer(cfgOrPath: SvrConfig | string): Promise<void> {
    let cfg: SvrConfig;
    if (typeof cfgOrPath === 'string') {
        cfg = loadMainThreadConfig(cfgOrPath);
    } else {
        cfg = cfgOrPath;
    }
    core = createServerCore(cfg);
    core.resetLoadBalancer();
    for (let i = 0; i < cfg.workerThreadNum; i++) {
        core.workerThreads.push(core.createWorker(i));
    }
    for (const cl of Object.values(cfg.clMap)) {
        await cl.startListen();
    }
    infoLog("start dog server successfully");
}

export function sendMsgToWorkerThread(msg: Msg): Promise<Msg> {
    return new Promise((resolve) => {
        msg.head.txnId = core!.txnMgr.genNewTxnId();
        const workerIndex = core!.loadBalancer!.selectWorkerIndex(msg, core!.workerThreads.length);
        const worker = core!.workerThreads[workerIndex];
        worker.postMessage(msg);
        core!.loadBalancer!.onMessageSent(workerIndex);
        core!.workerPendingTxns.get(worker)!.add(msg.head.txnId);
        core!.txnMgr.addTxn(msg.head.txnId, resolve, () => {
            core!.workerPendingTxns.get(worker)?.delete(msg.head.txnId!);
            core!.loadBalancer!.onMessageResolved(workerIndex);
            msg.head.errCode = -1;
            msg.head.errMsg = `txn timeout|txnId:${msg.head.txnId}`;
            msg.body = '';
            resolve(msg);
        });
    });
}

// ---- Hot update entry point ----

let isHotUpdating = false;

export async function hotUpdate() {
    if (isHotUpdating) {
        warnLog("hotUpdate called while already updating, ignoring");
        return;
    }
    isHotUpdating = true;
    try {
        const strategy = createHotUpdateStrategy(core!.svrCfg.hotUpdateStrategy);
        await strategy.execute(core!);
    } finally {
        isHotUpdating = false;
    }
}

export * from "./cl_base";
export { SvrConfig } from "./server_core";
export * from "../logger";
export * from "../message";
export { registerCLFactory, registerCLCFactory } from "./cl_factory";
export { loadMainThreadConfig, getMainThreadConfig, getConfigDir, MainThreadJsonConfig } from "./config";
