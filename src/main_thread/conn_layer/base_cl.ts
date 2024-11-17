import { Msg } from "../../message";

export type AuthFuncType = (msg: Msg) => Promise<boolean>;

export abstract class BaseCL {
    abstract startListen(): Promise<void>;

    setAuthFunc(authFunc: AuthFuncType): void {
        this.authFunc = authFunc;
    }
    authFunc: AuthFuncType | null = null;
}
