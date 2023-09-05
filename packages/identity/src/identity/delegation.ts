import {
  DerEncodedPublicKey,
  HttpAgentRequest,
  PublicKey,
  requestIdOf,
  Signature,
  SignIdentity,
} from '@dfinity/agent';
import { Principal } from '@dfinity/principal';
import * as cbor from 'simple-cbor';
import { fromHexString, toHexString } from '../buffer';
import { DelegationError } from './errors';

const domainSeparator = new TextEncoder().encode('\x1Aic-request-auth-delegation');
const requestDomainSeparator = new TextEncoder().encode('\x0Aic-request');
const MAXIMUM_NUMBER_OF_TARGETS = 1_000;
const MAXIMUM_DELEGATION_CHAIN_LENGTH = 20;

function _parseBlob(value: unknown): ArrayBuffer {
  if (typeof value !== 'string' || value.length < 64) {
    throw new DelegationError('Invalid public key.');
  }

  return fromHexString(value);
}

/**
 * A single delegation object that is signed by a private key. This is constructed by
 * `DelegationChain.create()`.
 *
 * {@see DelegationChain}
 */
export class Delegation {
  constructor(
    public readonly pubkey: ArrayBuffer,
    public readonly expiration: bigint,
    public readonly targets?: Principal[],
  ) {
    if (targets && targets?.length > MAXIMUM_NUMBER_OF_TARGETS) {
      throw new DelegationError(`Delegation targets cannot exceed ${MAXIMUM_NUMBER_OF_TARGETS}`);
    }
  }

  public toCBOR(): cbor.CborValue {
    // Expiration field needs to be encoded as a u64 specifically.
    return cbor.value.map({
      pubkey: cbor.value.bytes(this.pubkey),
      expiration: cbor.value.u64(this.expiration.toString(16), 16),
      ...(this.targets && {
        targets: cbor.value.array(this.targets.map(t => cbor.value.bytes(t.toUint8Array()))),
      }),
    });
  }

  public toJSON(): JsonnableDelegation {
    // every string should be hex and once-de-hexed,
    // discoverable what it is (e.g. de-hex to get JSON with a 'type' property, or de-hex to DER
    // with an OID). After de-hex, if it's not obvious what it is, it's an ArrayBuffer.
    return {
      expiration: this.expiration.toString(16),
      pubkey: toHexString(this.pubkey),
      ...(this.targets && { targets: this.targets.map(p => p.toHex()) }),
    };
  }
}

/**
 * Type of ReturnType<Delegation.toJSON>.
 * The goal here is to stringify all non-JSON-compatible types to some bytes representation we can
 * stringify as hex.
 * (Hex shouldn't be ambiguous ever, because you can encode as DER with semantic OIDs).
 */
interface JsonnableDelegation {
  // A BigInt of Nanoseconds since epoch as hex
  expiration: string;
  // Hexadecimal representation of the DER public key.
  pubkey: string;
  // Array of strings, where each string is hex of principal blob (*NOT* textual representation).
  targets?: string[];
}

/**
 * A signed delegation, which lends its identity to the public key in the delegation
 * object. This is constructed by `DelegationChain.create()`.
 *
 * {@see DelegationChain}
 */
export interface SignedDelegation {
  delegation: Delegation;
  signature: Signature;
}

/**
 * Sign a single delegation object for a period of time.
 *
 * @param from The identity that lends its delegation.
 * @param to The identity that receives the delegation.
 * @param expiration An expiration date for this delegation.
 * @param targets Limit this delegation to the target principals.
 */
async function _createSingleDelegation(
  from: SignIdentity,
  to: PublicKey,
  expiration: Date,
  targets?: Principal[],
): Promise<SignedDelegation> {
  // Validate inputs
  if (targets && targets?.length > MAXIMUM_NUMBER_OF_TARGETS) {
    throw new DelegationError(`Delegation targets cannot exceed ${MAXIMUM_NUMBER_OF_TARGETS}`);
  }
  if (!from.sign) {
    throw new DelegationError('The from identity does not have a sign method.');
  }
  if (!to.toDer) {
    throw new DelegationError('The to public key does not have a toDer method.');
  }

  const delegation: Delegation = new Delegation(
    to.toDer(),
    BigInt(+expiration) * BigInt(1000000), // In nanoseconds.
    targets,
  );
  // The signature is calculated by signing the concatenation of the domain separator
  // and the message.
  // Note: To ensure Safari treats this as a user gesture, ensure to not use async methods
  // besides the actualy webauthn functionality (such as `sign`). Safari will de-register
  // a user gesture if you await an async call thats not fetch, xhr, or setTimeout.
  const challenge = new Uint8Array([
    ...domainSeparator,
    ...new Uint8Array(requestIdOf(delegation)),
  ]);
  const signature = await from.sign(challenge);

  return {
    delegation,
    signature,
  };
}

export interface JsonnableDelegationChain {
  publicKey: string;
  delegations: Array<{
    signature: string;
    delegation: {
      pubkey: string;
      expiration: string;
      targets?: string[];
    };
  }>;
}

/**
 * A chain of delegations. This is JSON Serializable.
 * This is the object to serialize and pass to a DelegationIdentity. It does not keep any
 * private keys.
 */
export class DelegationChain {
  /**
   * Create a delegation chain between two (or more) keys. By default, the expiration time
   * will be very short (15 minutes).
   *
   * To build a chain of more than 2 identities, this function needs to be called multiple times,
   * passing the previous delegation chain into the options argument. For example:
   *
   * @example
   * const rootKey = createKey();
   * const middleKey = createKey();
   * const bottomeKey = createKey();
   *
   * const rootToMiddle = await DelegationChain.create(
   *   root, middle.getPublicKey(), Date.parse('2100-01-01'),
   * );
   * const middleToBottom = await DelegationChain.create(
   *   middle, bottom.getPublicKey(), Date.parse('2100-01-01'), { previous: rootToMiddle },
   * );
   *
   * // We can now use a delegation identity that uses the delegation above:
   * const identity = DelegationIdentity.fromDelegation(bottomKey, middleToBottom);
   *
   * @param from The identity that will delegate.
   * @param to The identity that gets delegated. It can now sign messages as if it was the
   *           identity above.
   * @param expiration The length the delegation is valid. By default, 15 minutes from calling
   *                   this function.
   * @param options A set of options for this delegation. expiration and previous
   * @param options.previous - Another DelegationChain that this chain should start with.
   * @param options.targets - targets that scope the delegation (e.g. Canister Principals)
   */
  public static async create(
    from: SignIdentity,
    to: PublicKey,
    expiration: Date = new Date(Date.now() + 15 * 60 * 1000),
    options: {
      previous?: DelegationChain;
      targets?: Principal[];
    } = {},
  ): Promise<DelegationChain> {
    if (options.previous) {
      const usedPublicKeys = new Set<ArrayBuffer>();
      let currentPublicKey = to.toDer();

      for (const delegation of options.previous.delegations) {
        if (usedPublicKeys.has(currentPublicKey)) {
          throw new DelegationError('Delegation target cannot be repeated in the chain.');
        }
        usedPublicKeys.add(currentPublicKey);
        currentPublicKey = delegation.delegation.pubkey;
      }

      if (usedPublicKeys.has(currentPublicKey)) {
        throw new DelegationError('Error: Cannot repeat public keys in a delegation chain.');
      }
    }

    const delegation = await _createSingleDelegation(from, to, expiration, options.targets);
    return new DelegationChain(
      [...(options.previous?.delegations || []), delegation],
      options.previous?.publicKey || from.getPublicKey().toDer(),
    );
  }

  /**
   * Creates a DelegationChain object from a JSON string.
   *
   * @param json The JSON string to parse.
   */
  public static fromJSON(json: string | JsonnableDelegationChain): DelegationChain {
    const { publicKey, delegations } = typeof json === 'string' ? JSON.parse(json) : json;
    if (!Array.isArray(delegations)) {
      throw new DelegationError('Invalid delegations.');
    }

    const parsedDelegations: SignedDelegation[] = delegations.map(signedDelegation => {
      const { delegation, signature } = signedDelegation;
      const { pubkey, expiration, targets } = delegation;
      if (targets !== undefined && !Array.isArray(targets)) {
        throw new DelegationError('Invalid targets.');
      }

      return {
        delegation: new Delegation(
          _parseBlob(pubkey),
          BigInt(`0x${expiration}`), // expiration in JSON is an hexa string (See toJSON() below).
          targets &&
            targets.map((t: unknown) => {
              if (typeof t !== 'string') {
                throw new DelegationError('Invalid target.');
              }
              return Principal.fromHex(t);
            }),
        ),
        signature: _parseBlob(signature) as Signature,
      };
    });

    return new this(parsedDelegations, _parseBlob(publicKey) as DerEncodedPublicKey);
  }

  /**
   * Creates a DelegationChain object from a list of delegations and a DER-encoded public key.
   *
   * @param delegations The list of delegations.
   * @param publicKey The DER-encoded public key of the key-pair signing the first delegation.
   */
  public static fromDelegations(
    delegations: SignedDelegation[],
    publicKey: DerEncodedPublicKey,
  ): DelegationChain {
    return new this(delegations, publicKey);
  }

  protected constructor(
    public readonly delegations: SignedDelegation[],
    public readonly publicKey: DerEncodedPublicKey,
    public readonly previous?: DelegationChain,
  ) {
    if (delegations.length > MAXIMUM_DELEGATION_CHAIN_LENGTH) {
      throw new DelegationError(
        `Delegation chain cannot exceed ${MAXIMUM_DELEGATION_CHAIN_LENGTH}`,
      );
    }
  }

  public toJSON(): JsonnableDelegationChain {
    return {
      delegations: this.delegations.map(signedDelegation => {
        const { delegation, signature } = signedDelegation;
        const { targets } = delegation;
        return {
          delegation: {
            expiration: delegation.expiration.toString(16),
            pubkey: toHexString(delegation.pubkey),
            ...(targets && {
              targets: targets.map(t => t.toHex()),
            }),
          },
          signature: toHexString(signature),
        };
      }),
      publicKey: toHexString(this.publicKey),
    };
  }
}

/**
 * An Identity that adds delegation to a request. Everywhere in this class, the name
 * innerKey refers to the SignIdentity that is being used to sign the requests, while
 * originalKey is the identity that is being borrowed. More identities can be used
 * in the middle to delegate.
 */
export class DelegationIdentity extends SignIdentity {
  /**
   * Create a delegation without having access to delegateKey.
   *
   * @param key The key used to sign the reqyests.
   * @param delegation A delegation object created using `createDelegation`.
   */
  public static fromDelegation(
    key: Pick<SignIdentity, 'sign'>,
    delegation: DelegationChain,
  ): DelegationIdentity {
    return new this(key, delegation);
  }

  protected constructor(
    private _inner: Pick<SignIdentity, 'sign'>,
    private _delegation: DelegationChain,
  ) {
    super();
  }

  public getDelegation(): DelegationChain {
    return this._delegation;
  }

  public getPublicKey(): PublicKey {
    return {
      toDer: () => this._delegation.publicKey,
    };
  }
  public sign(blob: ArrayBuffer): Promise<Signature> {
    return this._inner.sign(blob);
  }

  public async transformRequest(request: HttpAgentRequest): Promise<unknown> {
    const { body, ...fields } = request;
    const requestId = await requestIdOf(body);
    return {
      ...fields,
      body: {
        content: body,
        sender_sig: await this.sign(
          new Uint8Array([...requestDomainSeparator, ...new Uint8Array(requestId)]),
        ),
        sender_delegation: this._delegation.delegations,
        sender_pubkey: this._delegation.publicKey,
      },
    };
  }
}

/**
 * List of things to check for a delegation chain validity.
 */
export interface DelegationValidChecks {
  /**
   * Check that the scope is amongst the scopes that this delegation has access to.
   */
  scope?: Principal | string | Array<Principal | string>;
}

/**
 * Analyze a DelegationChain and validate that it's valid, ie. not expired and apply to the
 * scope.
 * @param chain The chain to validate.
 * @param checks Various checks to validate on the chain.
 */
export function isDelegationValid(chain: DelegationChain, checks?: DelegationValidChecks): boolean {
  // Verify that the no delegation is expired. If any are in the chain, returns false.
  for (const { delegation } of chain.delegations) {
    // prettier-ignore
    if (+new Date(Number(delegation.expiration / BigInt(1000000))) <= +Date.now()) {
      return false;
    }
  }

  // Check the scopes.
  const scopes: Principal[] = [];
  const maybeScope = checks?.scope;
  if (maybeScope) {
    if (Array.isArray(maybeScope)) {
      scopes.push(...maybeScope.map(s => (typeof s === 'string' ? Principal.fromText(s) : s)));
    } else {
      scopes.push(typeof maybeScope === 'string' ? Principal.fromText(maybeScope) : maybeScope);
    }
  }

  for (const s of scopes) {
    const scope = s.toText();
    for (const { delegation } of chain.delegations) {
      if (delegation.targets === undefined) {
        continue;
      }

      let none = true;
      for (const target of delegation.targets) {
        if (target.toText() === scope) {
          none = false;
          break;
        }
      }
      if (none) {
        return false;
      }
    }
  }

  return true;
}
