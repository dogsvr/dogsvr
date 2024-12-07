import { parentPort } from 'worker_threads';
import { errorLog } from '../logger';
import { Msg, MsgBodyType } from '../message';
import { TxnMgr } from "../transaction";

export type HandlerType = (reqMsg: Msg, innerReq: MsgBodyType) => Promise<void>;
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

parentPort!.on('message', (msg: Msg) => {
    if (msg.clcOptions) {
        let cb = txnMgr.onCallback(msg.txnId);
        if (cb) {
            cb(msg.body);
        } else {
            errorLog(`No callback for txnId ${msg.txnId}|${msg.cmdId}|${msg.clcOptions}`);
        }
    } else {
        const handler = handlerMap[msg.cmdId];
        if (handler) {
            handler(msg, msg.body);
        } else {
            errorLog(`No handler for cmdId ${msg.cmdId}`);
        }
    }
}
);

export function respondCmd(reqMsg: Msg, innerRes: MsgBodyType) {
    reqMsg.body = innerRes;
    parentPort!.postMessage(reqMsg);
}

export function callCmdByClc(clcName: string, cmdId: number, innerReq: MsgBodyType, options?: any): Promise<MsgBodyType> {
    return new Promise((resolve, reject) => {
        let msg = new Msg(cmdId, txnMgr.genNewTxnId(), innerReq, { clcName: clcName });
        parentPort!.postMessage(msg);
        txnMgr.addTxn(msg.txnId, resolve);
    });
}

export * from "../message"
export * from "../logger"
