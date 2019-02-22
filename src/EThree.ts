import PrivateKeyLoader from './PrivateKeyLoader';
import {
    CachingJwtProvider,
    KeyEntryAlreadyExistsError,
    CardManager,
    VirgilCardVerifier,
    IKeyEntryStorage,
    IAccessTokenProvider,
    KeyEntryStorage,
} from 'virgil-sdk';
import {
    VirgilPublicKey,
    Data,
    VirgilCrypto,
    VirgilCardCrypto,
    VirgilPrivateKey,
} from 'virgil-crypto/dist/virgil-crypto-pythia.es';
import {
    RegisterRequiredError,
    EmptyArrayError,
    IdentityAlreadyExistsError,
    PrivateKeyAlreadyExistsError,
    MultipleCardsError,
    LookupNotFoundError,
    LookupError,
    DUPLICATE_IDENTITIES,
} from './errors';
import { isArray, isString } from './utils/typeguards';
import { hasDuplicates, getObjectValues } from './utils/array';

interface IEThreeInitOptions {
    keyEntryStorage?: IKeyEntryStorage;
    apiUrl?: string;
}

interface IEThreeCtorOptions extends IEThreeInitOptions {
    accessTokenProvider: IAccessTokenProvider;
}

const throwIllegalInvocationError = (method: string) => {
    throw new Error(`Calling ${method} two or more times in a row is not allowed.`);
};

export type KeyPair = {
    privateKey: VirgilPrivateKey;
    publicKey: VirgilPublicKey;
};

export type LookupResult = {
    [identity: string]: VirgilPublicKey;
};

type EncryptVirgilPublicKeyArg = LookupResult | VirgilPublicKey;

const _inProcess = Symbol('inProcess');
const _keyLoader = Symbol('keyLoader');
const STORAGE_NAME = '.virgil-local-storage';
export default class EThree {
    identity: string;
    virgilCrypto = new VirgilCrypto();
    cardCrypto = new VirgilCardCrypto(this.virgilCrypto);
    cardVerifier: VirgilCardVerifier;

    cardManager: CardManager;
    accessTokenProvider: IAccessTokenProvider;
    keyEntryStorage: IKeyEntryStorage;

    private [_keyLoader]: PrivateKeyLoader;
    private [_inProcess]: boolean = false;

    static async initialize(getToken: () => Promise<string>, options: IEThreeInitOptions = {}) {
        const opts = { accessTokenProvider: new CachingJwtProvider(getToken), ...options };
        const token = await opts.accessTokenProvider.getToken({ operation: 'get' });
        const identity = token.identity();
        return new EThree(identity, opts);
    }

    constructor(identity: string, options: IEThreeCtorOptions) {
        this.identity = identity;
        this.accessTokenProvider = options.accessTokenProvider;
        this.keyEntryStorage = options.keyEntryStorage || new KeyEntryStorage(STORAGE_NAME);
        this.cardVerifier = new VirgilCardVerifier(this.cardCrypto, {
            verifySelfSignature: !options.apiUrl,
            verifyVirgilSignature: !options.apiUrl,
        });

        this[_keyLoader] = new PrivateKeyLoader(this.identity, {
            accessTokenProvider: this.accessTokenProvider,
            virgilCrypto: this.virgilCrypto,
            keyEntryStorage: this.keyEntryStorage,
            apiUrl: options.apiUrl,
        });

        this.cardManager = new CardManager({
            cardCrypto: this.cardCrypto,
            cardVerifier: this.cardVerifier,
            accessTokenProvider: this.accessTokenProvider,
            retryOnUnauthorized: true,
            apiUrl: options.apiUrl,
        });
    }

    async register() {
        if (this[_inProcess]) throwIllegalInvocationError('register');
        this[_inProcess] = true;
        try {
            const [cards, privateKey] = await Promise.all([
                this.cardManager.searchCards(this.identity),
                this[_keyLoader].loadLocalPrivateKey(),
            ]);
            if (cards.length > 1) throw new MultipleCardsError(this.identity);
            if (cards.length > 0) throw new IdentityAlreadyExistsError();
            if (privateKey && cards.length === 0) await this[_keyLoader].resetLocalPrivateKey();
            const keyPair = this.virgilCrypto.generateKeys();
            await this._publishCard(keyPair);
            await this[_keyLoader].savePrivateKeyLocal(keyPair.privateKey);
        } finally {
            this[_inProcess] = false;
        }
        return;
    }

    async rotatePrivateKey(): Promise<void> {
        if (this[_inProcess]) throwIllegalInvocationError('rotatePrivateKey');
        this[_inProcess] = true;
        try {
            const [cards, privateKey] = await Promise.all([
                this.cardManager.searchCards(this.identity),
                this[_keyLoader].loadLocalPrivateKey(),
            ]);
            if (cards.length === 0) throw new RegisterRequiredError();
            if (cards.length > 1) throw new MultipleCardsError(this.identity);
            if (privateKey) throw new PrivateKeyAlreadyExistsError();
            const keyPair = this.virgilCrypto.generateKeys();
            await this._publishCard(keyPair, cards[0].id);
            await this[_keyLoader].savePrivateKeyLocal(keyPair.privateKey);
        } finally {
            this[_inProcess] = false;
        }
    }

    async restorePrivateKey(pwd: string): Promise<void> {
        try {
            await this[_keyLoader].restorePrivateKey(pwd);
        } catch (e) {
            if (e instanceof KeyEntryAlreadyExistsError) {
                throw new PrivateKeyAlreadyExistsError();
            }
            throw e;
        }
    }

    async cleanup() {
        await this[_keyLoader].resetLocalPrivateKey();
    }

    async resetPrivateKeyBackup(pwd?: string) {
        if (!pwd) return await this[_keyLoader].resetAll();
        return this[_keyLoader].resetPrivateKeyBackup(pwd);
    }

    async encrypt(
        message: ArrayBuffer,
        publicKey?: EncryptVirgilPublicKeyArg,
    ): Promise<ArrayBuffer>;
    async encrypt(message: string, publicKeys?: EncryptVirgilPublicKeyArg): Promise<string>;
    async encrypt(message: Buffer, publicKey?: EncryptVirgilPublicKeyArg): Promise<Buffer>;
    async encrypt(message: Data, publicKeys?: EncryptVirgilPublicKeyArg): Promise<Data> {
        const isMessageString = isString(message);
        let argument: VirgilPublicKey[];

        if (publicKeys == null) argument = [];
        else if (publicKeys instanceof VirgilPublicKey) argument = [publicKeys];
        else argument = getObjectValues(publicKeys) as VirgilPublicKey[];

        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();

        const ownPublicKey = this.virgilCrypto.extractPublicKey(privateKey);

        if (!this._isOwnPublicKeysIncluded(ownPublicKey, argument)) {
            argument.push(ownPublicKey);
        }

        const res: Data = this.virgilCrypto.signThenEncrypt(message, privateKey, argument);
        if (isMessageString) return res.toString('base64');
        return res;
    }

    async decrypt(message: string, publicKey?: VirgilPublicKey): Promise<string>;
    async decrypt(message: Buffer, publicKey?: VirgilPublicKey): Promise<Buffer>;
    async decrypt(message: ArrayBuffer, publicKey?: VirgilPublicKey): Promise<Buffer>;
    async decrypt(message: Data, publicKey?: VirgilPublicKey): Promise<Data> {
        const isMessageString = isString(message);

        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();
        if (!publicKey) publicKey = this.virgilCrypto.extractPublicKey(privateKey);

        const res: Data = this.virgilCrypto.decryptThenVerify(message, privateKey, publicKey);
        if (isMessageString) return res.toString('utf8') as string;
        return res as Buffer;
    }

    async lookupPublicKeys(identities: string): Promise<VirgilPublicKey>;
    async lookupPublicKeys(identities: string[]): Promise<LookupResult>;
    async lookupPublicKeys(identities: string[] | string): Promise<LookupResult | VirgilPublicKey> {
        const argument = isArray(identities) ? identities : [identities];
        if (argument.length === 0) throw new EmptyArrayError('lookupPublicKeys');
        if (hasDuplicates(argument)) throw new Error(DUPLICATE_IDENTITIES);

        const cards = await this.cardManager.searchCards(argument);

        let result: LookupResult = {},
            resultWithErrors: { [identity: string]: Error } = {};

        for (let identity of argument) {
            const filteredCards = cards.filter(card => card.identity === identity);
            if (filteredCards.length === 0) {
                resultWithErrors[identity] = new LookupNotFoundError(identity);
            } else if (filteredCards.length > 1) {
                resultWithErrors[identity] = new MultipleCardsError(identity);
            } else {
                result[identity] = filteredCards[0].publicKey as VirgilPublicKey;
            }
        }

        if (getObjectValues(resultWithErrors).length !== 0) {
            throw new LookupError({ ...resultWithErrors, ...result });
        }

        if (Array.isArray(identities)) return result;

        return result[identities];
    }

    async changePassword(oldPwd: string, newPwd: string) {
        return await this[_keyLoader].changePassword(oldPwd, newPwd);
    }

    async backupPrivateKey(pwd: string): Promise<void> {
        const privateKey = await this[_keyLoader].loadLocalPrivateKey();
        if (!privateKey) throw new RegisterRequiredError();
        await this[_keyLoader].savePrivateKeyRemote(privateKey, pwd);
        return;
    }

    hasLocalPrivateKey(): Promise<Boolean> {
        return this[_keyLoader].hasPrivateKey();
    }

    private async _publishCard(keyPair: KeyPair, previousCardId?: string) {
        const card = await this.cardManager.publishCard({
            privateKey: keyPair.privateKey,
            publicKey: keyPair.publicKey,
            previousCardId,
        });

        return { keyPair, card };
    }

    private _isOwnPublicKeysIncluded(ownPublicKey: VirgilPublicKey, publicKeys: VirgilPublicKey[]) {
        const selfPublicKey = this.virgilCrypto.exportPublicKey(ownPublicKey).toString('base64');

        const stringKeys = publicKeys.map(key =>
            this.virgilCrypto.exportPublicKey(key).toString('base64'),
        );
        return stringKeys.some((key, i) => key === selfPublicKey);
    }
}
