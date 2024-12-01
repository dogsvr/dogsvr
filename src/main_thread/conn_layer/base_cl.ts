import { Msg } from "../../message";

export type AuthFuncType = (msg: Msg) => Promise<boolean>;

export abstract class BaseCL {
    abstract startListen(): Promise<void>;

    setAuthFunc(authFunc: AuthFuncType): void { }
}

// client that communicates with connection layer
export abstract class BaseCLC {
    abstract call(msg: Msg): Promise<Msg>;
}
