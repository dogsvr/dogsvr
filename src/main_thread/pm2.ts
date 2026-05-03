import { hotUpdate } from './index';
import { errorLog, infoLog } from '../logger';

// Expose `hotUpdate` as a pm2 action so operators can invoke it with
// `pm2 trigger <name> hotUpdate`, preserving the previous CLI contract.
//
// Wire protocol (undocumented but stable pm2 axm convention):
//  - Announce the action to the pm2 daemon once on startup by sending
//    { type: 'axm:action', data: { action_name, arity } } over the IPC channel.
//  - pm2 then delivers the plain string action_name as an IPC message when the
//    user runs `pm2 trigger`.
//  - Reply via { type: 'axm:reply', data: { action_name, return } } so the
//    triggering CLI unblocks and prints the return value.
//
// Using the native child_process IPC channel (process.send / process.on('message'))
// intentionally, instead of pulling in `tx2` — tx2 1.0.5 is incompatible with
// TypeScript 6's __importStar expansion of its singleton default export.
//
// The main_thread <-> worker_thread channel is a completely separate
// MessagePort (worker_threads module), so this listener does not interfere
// with worker message dispatch.

const HOT_UPDATE_ACTION = 'hotUpdate';

if (process.send) {
    process.send({
        type: 'axm:action',
        data: { action_name: HOT_UPDATE_ACTION, arity: 0 },
    });
    infoLog(`pm2 action registered: ${HOT_UPDATE_ACTION}`);
}

process.on('message', async (msg: unknown) => {
    if (msg !== HOT_UPDATE_ACTION) {
        return;
    }
    try {
        await hotUpdate();
        process.send?.({
            type: 'axm:reply',
            data: { action_name: HOT_UPDATE_ACTION, return: 'hotUpdate done' },
        });
    } catch (e: unknown) {
        const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
        errorLog(`hotUpdate failed: ${detail}`);
        process.send?.({
            type: 'axm:reply',
            data: {
                action_name: HOT_UPDATE_ACTION,
                return: `hotUpdate failed: ${detail}`,
            },
        });
    }
});
