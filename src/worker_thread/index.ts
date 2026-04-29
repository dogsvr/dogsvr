import { parentPort } from 'worker_threads';
import { errorLog } from '../logger';
import { Msg, MsgHeadType, MsgBodyType, HandlerError } from '../message';
import { TxnMgr } from "../transaction";

export type HandlerRsp =
    | MsgBodyType                                          // body only
    | { body: MsgBodyType, head?: Partial<MsgHeadType> }   // body + head patch
    | void;                                                 // silent drop
export type HandlerType = (reqMsg: Msg) => Promise<HandlerRsp>;
type HandlerMapType = { [key: number]: HandlerType }
const handlerMap: HandlerMapType = {};
const txnMgr: TxnMgr = new TxnMgr();

export function regCmdHandler(cmdId: number, handler: HandlerType) {
    if (handlerMap[cmdId]) {
        errorLog(`Handler for cmdId ${cmdId} already exists`);
        return;
    }
    handlerMap[cmdId] = handler;
}

export async function workerReady(initFn: () => Promise<void>) {
    process.on('unhandledRejection', (err) => {
        errorLog('unhandledRejection|err:', err);
    });
    process.on('uncaughtException', (err) => {
        errorLog('uncaughtException|err:', err);
    });

    await initFn();
    parentPort!.on('message', (msg: Msg) => {
        if (msg.head.clcOptions) {
            let cb = txnMgr.onCallback(msg.head.txnId!);
            if (cb) {
                cb(msg.body);
            } else {
                errorLog(`No callback for txnId ${msg.head.txnId}|${msg.head.cmdId}`);
            }
        } else {
            const handler = handlerMap[msg.head.cmdId];
            if (handler) {
                handler(msg)
                    .then((ret) => {
                        if (ret === undefined) return;   // 严格 undefined 比较,空字符串是合法 body
                        if (typeof ret === 'string' || ret instanceof Uint8Array) {
                            respondCmd(msg, ret);
                        } else {
                            if (ret.head) Object.assign(msg.head, ret.head);
                            respondCmd(msg, ret.body);
                        }
                    })
                    .catch((err) => {
                        if (err instanceof HandlerError) {
                            respondError(msg, err.code, err.msg);
                            return;
                        }
                        errorLog(`Handler exception|cmdId:${msg.head.cmdId}|openId:${msg.head.openId ?? ''}|gid:${msg.head.gid ?? 0}|txnId:${msg.head.txnId ?? 0}|err:`, err);
                        respondError(msg, -1, `Handler exception: ${err}`);
                    });
            } else {
                errorLog(`No handler for cmdId ${msg.head.cmdId}`);
            }
        }
    });
}

export function respondCmd(reqMsg: Msg, innerRes: MsgBodyType) {
    reqMsg.body = innerRes;
    parentPort!.postMessage(reqMsg);
}

export function respondError(reqMsg: Msg, errCode: number, errMsg: string) {
    reqMsg.head.errCode = errCode;
    reqMsg.head.errMsg = errMsg;
    reqMsg.body = '';
    parentPort!.postMessage(reqMsg);
}

export function callCmdByClc(clcName: string, msgHead: MsgHeadType, innerReq: MsgBodyType, noResponse?: boolean): Promise<MsgBodyType | null> | void {
    if (noResponse) {
        msgHead.clcOptions = { clcName: clcName, noResponse: true };
        let msg = new Msg(msgHead, innerReq);
        parentPort!.postMessage(msg);
    }
    else {
        return new Promise((resolve, reject) => {
            msgHead.txnId = txnMgr.genNewTxnId();
            msgHead.clcOptions = { clcName: clcName };
            let msg = new Msg(msgHead, innerReq);
            parentPort!.postMessage(msg);
            txnMgr.addTxn(msg.head.txnId!, resolve);
        });
    }
}

export function pushMsgByCl(clName: string, gids: number[], msgHead: MsgHeadType, innerReq: MsgBodyType) {
    msgHead.clOptions = { clName: clName, gids: gids };
    let msg = new Msg(msgHead, innerReq);
    parentPort!.postMessage(msg);
}

export * from "../message"
export * from "../logger"
export { loadWorkerThreadConfig, getThreadConfig, WorkerThreadBaseConfig } from "./config"
