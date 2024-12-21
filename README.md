# dogsvr
dogsvr is a game server package based on nodejs, and makes writing game server easier for rapid development of small teams.

# features
- Adapt to multiple connection methods
- User-defined protocol serialization
- Hot update server logic

# usage
1. installing dogsvr
```
npm install @dogsvr/dogsvr
npm install @dogsvr/cl-tsrpc
```
2. creating 2 files at least, one is main thread file, the other is worker thread file

3. writing main thread file
```ts
import * as dogsvr from '@dogsvr/dogsvr/main_thread';
import { TsrpcCL } from '@dogsvr/cl-tsrpc';
import * as path from "node:path";

const connLayer: TsrpcCL = new TsrpcCL("ws", 3000); // connection layer using tsrpc
const svrCfg: dogsvr.SvrConfig =
{
    workerThreadRunFile: path.resolve(__dirname, "test_svr_logic.js"), // worker thread file name
    workerThreadNum: 2,
    clMap: { "tsrpc": connLayer },
    clcMap: {}
}
dogsvr.startServer(svrCfg);
```
4. writing worker thread file
```ts
import * as dogsvr from '@dogsvr/dogsvr/worker_thread';

// register command handler
dogsvr.regCmdHandler(10001, async (reqMsg: dogsvr.Msg, innerReq: dogsvr.MsgBodyType) => {
    const req = JSON.parse(innerReq as string);

    const res = {res: "I am dog"};
    dogsvr.respondCmd(reqMsg, JSON.stringify(res));
})
```
5. run server by pm2
```sh
pm2 start test_svr.js  #test_svr.js is main thread file
pm2 trigger test_svr hotUpdate  #hot update when any logic file has been changed
```
Please see [example-proj](https://github.com/dogsvr/example-proj) for complete codes.

# architecture
TODO
