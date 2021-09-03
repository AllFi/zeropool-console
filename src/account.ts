import AES from 'crypto-js/aes';
import Utf8 from 'crypto-js/enc-utf8';
import bcrypt from 'bcryptjs';

import paramsUrl from '../assets/params.bin';
import { HDWallet, CoinType, Balance, devConfig, prodConfig } from 'zeropool-api-js';
import { Config } from 'zeropool-api-js/lib/config';

const LOCK_TIMEOUT = 5 * 60 * 1000; // 5 minutes

interface AccountStorage {
    get(accountName: string, field: string): string | null;
    set(accountName: string, field: string, value: string);
}

class LocalAccountStorage implements AccountStorage {
    get(accountName: string, field: string): string | null {
        return localStorage.getItem(`zconsole.${accountName}.${field}`);
    }
    set(accountName: string, field: string, value: string) {
        localStorage.setItem(`zconsole.${accountName}.${field}`, value);
    }
}

const ENABLED_COINS = [CoinType.ethereum, CoinType.near, CoinType.waves];

export enum Env {
    Prod = 'prod',
    Dev = 'dev',
}

// TODO: Extract timeout management code
export default class Account {
    private lockTimeout?: ReturnType<typeof setTimeout>;
    readonly accountName: string;
    private storage: AccountStorage;
    public hdWallet: HDWallet;
    private config: Config;

    constructor(accountName: string, env: Env) {
        this.accountName = accountName;
        this.storage = new LocalAccountStorage();

        switch (env) {
            case Env.Prod:
                this.config = prodConfig;
                break;
            case Env.Dev:
                this.config = devConfig;
                break;
        }

        this.config.ethereum.contractAddress = '0xF0F6Aa84993071Bf92f26fC0c0DD33991f431851';
        this.config.ethereum.httpProviderUrl = 'http://127.0.0.1:8545';

        this.config.paramsUrl = paramsUrl;
    }

    public async login(seed: string, password: string) {
        this.storage.set(this.accountName, 'seed', await AES.encrypt(seed, password).toString());
        this.storage.set(this.accountName, 'pwHash', await bcrypt.hash(password, await bcrypt.genSalt(10)));
        this.hdWallet = await HDWallet.init(seed, this.config, ENABLED_COINS);

        this.setAccountTimeout(LOCK_TIMEOUT);
    }

    public isAccountPresent(): boolean {
        return !!this.storage.get(this.accountName, 'pwHash');
    }

    public getSeed(password: string): string {
        this.checkPassword(password);

        return this.decryptSeed(password);
    }

    public async unlockAccount(password: string) {
        this.checkPassword(password);

        const seed = this.decryptSeed(password);
        this.hdWallet = await HDWallet.init(seed, this.config, ENABLED_COINS);
    }

    public checkPassword(password: String) {
        const hash = this.storage.get(this.accountName, 'pwHash');

        if (!bcrypt.compare(hash, password)) {
            throw new Error('Incorrect password');
        }

        this.setAccountTimeout(LOCK_TIMEOUT);
    }

    public isLocked(): boolean {
        return !this.hdWallet;
    }

    public requireAuth() {
        if (this.isLocked()) {
            throw Error('Account is locked. Unlock the account first');
        }

        this.setAccountTimeout(LOCK_TIMEOUT);
    }

    public getRegularAddress(chainId: string, account: number = 0): string {
        this.requireAuth();

        const coin = this.hdWallet.getCoin(chainId as CoinType);

        return coin.getAddress(account);
    }

    public getPrivateAddress(chainId: string): string {
        this.requireAuth();

        const coin = this.hdWallet.getCoin(chainId as CoinType);

        return coin.generatePrivateAddress();
    }

    public async getRegularPrivateKey(chainId: string, accountIndex: number, password: string): Promise<string> {
        await this.unlockAccount(password);

        const coin = this.hdWallet.getCoin(chainId as CoinType);

        return coin.getPrivateKey(accountIndex);
    }

    public async getBalances(): Promise<{ [key in CoinType]?: Balance[] }> {
        this.requireAuth();

        return this.hdWallet.getBalances(5);
    }

    public async getBalance(chainId: CoinType, account: number = 0): Promise<[string, string]> {
        this.requireAuth();
        const coin = this.hdWallet.getCoin(chainId);
        const balance = await coin.getBalance(account);
        const readable = await coin.fromBaseUnit(balance);

        return [balance, readable];
    }

    public async transfer(chainId: string, account: number, to: string, amount: string): Promise<void> {
        this.requireAuth();

        const coin = this.hdWallet.getCoin(chainId as CoinType);
        await coin.transfer(account, to, amount);
    }


    // TODO: account number is temporary, it should not be needed when using a relayer
    public async transferPrivate(chainId: string, account: number, to: string, amount: string): Promise<void> {
        this.requireAuth();

        const coin = this.hdWallet.getCoin(chainId as CoinType);
        await coin.updatePrivateState();
        await coin.transferPrivateSimple(account, [{ to, amount }]);
    }

    public async depositPrivate(chainId: string, account: number, amount: string): Promise<void> {
        this.requireAuth();

        const coin = this.hdWallet.getCoin(chainId as CoinType);
        await coin.updatePrivateState();
        await coin.depositPrivate(account, amount);
    }

    public async withdrawPrivate(chainId: string, account: number, amount: string): Promise<void> {
        this.requireAuth();

        const coin = this.hdWallet.getCoin(chainId as CoinType);
        await coin.updatePrivateState();
        await coin.withdrawPrivate(account, amount);
    }

    public async makePrivateTx(chainId: string, to: string, amount: string): Promise<string> {
        this.requireAuth();

        const coin = this.hdWallet.getCoin(chainId as CoinType);
        await coin.updatePrivateState();
        const tx = await coin.privateAccount.createTx('transfer', [{ to, amount }]);

        return JSON.stringify(tx, null, 2);
    }

    private setAccountTimeout(ms: number) {
        if (this.lockTimeout) {
            clearTimeout(this.lockTimeout);
        }

        this.lockTimeout = setTimeout(function () {
            this.seed = null;
        }, ms);
    }

    private decryptSeed(password: string): string {
        const cipherText = this.storage.get(this.accountName, 'seed');
        const seed = AES.decrypt(cipherText, password).toString(Utf8);

        return seed;
    }
}