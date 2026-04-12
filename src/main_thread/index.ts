import { BaseCL } from "./base_cl";
import { Msg } from "../message";
import { infoLog, warnLog } from "../logger";
import { SvrConfig, ServerCore, createServerCore } from "./server_core";
import { createHotUpdateStrategy } from "./hot_update";
import "./pm2"

let core: ServerCore | null = null;

export function getConnLayer(clName: string): BaseCL {
    return core!.svrCfg.clMap[clName];
}

export async function startServer(cfg: SvrConfig) {
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
        core!.txnMgr.addTxn(msg.head.txnId, resolve);
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

export * from "./base_cl";
export { SvrConfig } from "./server_core";
export * from "../logger";
export * from "../message";
