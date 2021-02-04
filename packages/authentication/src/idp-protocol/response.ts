import * as oauth2 from './oauth2';
import * as assert from 'assert';
import { hexToBytes } from './bytes';

/**
 * @param url - url in which to detect an AuthenticationResponse
 * @returns whether the provided url is an AuthenticationResponse url
 */
export function isMaybeAuthenticationResponseUrl(url: URL | unknown): boolean {
  if (!(url && 'searchParams' in (url as URL))) {
    return false;
  }
  return (url as URL)?.searchParams?.has('access_token');
}

export type AuthenticationResponse = {
  type: 'AuthenticationResponse';
  accessToken: string;
  tokenType: 'bearer';
  expiresIn: number;
  state?: string;
  scope?: string;
};

function AuthenticationResponse(input: oauth2.OAuth2AccessTokenResponse): AuthenticationResponse {
  const response: AuthenticationResponse = {
    type: 'AuthenticationResponse',
    accessToken: input.access_token,
    tokenType: input.token_type || 'bearer',
    expiresIn: input.expires_in,
    state: input.state,
    scope: input.scope,
  };
  return response;
}

/**
 * Parse an AuthenticationResponse from a URL Query string.
 *
 * @param searchParams URLSearchParams from which to parse an AuthenticationResponse
 * @returns the response parsed from searchParams
 */
export function fromQueryString(searchParams: URLSearchParams): AuthenticationResponse {
  const oauth2Message = oauth2.fromQueryString(searchParams);
  if (oauth2Message && 'access_token' in oauth2Message) {
    return AuthenticationResponse(oauth2Message);
  }
  throw new Error(`Unable to create AuthenticationResponse from URLSearchParams`);
}

interface IParsedBearerToken {
  publicKey: string;
  delegations: Array<{
    delegation: {
      expiration: string;
      pubkey: string;
    };
    signature: string;
  }>;
}

/**
 * Parse a Bearer token from IC IDP oauth2 AccessTokenResponse into the IC info related to sender_delegation
 *
 * @param icIdpBearerToken {string} hex-encoded utf8 JSON generated by @dfinity/agent `DelegationChain.toJSON()`
 * @returns parsed bearer token
 */
export function parseBearerToken(icIdpBearerToken: string): IParsedBearerToken {
  const bytes = hexToBytes(icIdpBearerToken);
  const json = decodeUtf8(bytes);
  const parsed = JSON.parse(json);
  const publicKey = parsed.publicKey as unknown;
  const delegations = parsed.delegations as unknown;
  if (typeof publicKey !== 'string') {
    throw new Error('publicKey must be a string');
  }
  assert.ok(delegations);
  const result: IParsedBearerToken = {
    publicKey,
    delegations: delegations as IParsedBearerToken['delegations'],
  };
  return result;
}

function decodeUtf8(bytes: Uint8Array): string {
  const TextDecoder =
    globalThis.TextDecoder ||
    /* eslint-disable-next-line @typescript-eslint/no-var-requires */
    require('util').TextDecoder;
  return new TextDecoder().decode(bytes);
}

/**
 * Convert an ic-id AuthenticationResponse to an oauth2 AccessTokenResponse.
 * This is mostly converting to underscore_case.
 * @param response - ic-id AuthenticationResponse
 */
export function toOauth(response: AuthenticationResponse): oauth2.OAuth2AccessTokenResponse {
  const oauth2Response: oauth2.OAuth2AccessTokenResponse = {
    access_token: response.accessToken,
    token_type: 'bearer',
    expires_in: response.expiresIn,
    state: response.state,
    scope: response.scope,
  }
  return oauth2Response
}
