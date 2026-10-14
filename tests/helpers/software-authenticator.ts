import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/** A private ES256 authenticator, never linked by production source or routes. */
export class SoftwareAuthenticator {
  private readonly key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  private readonly credential = randomBytes(32);
  private counter = 0;
  private handle = '';
  readonly id = this.credential.toString('base64url');
  constructor(readonly origin: string) {}
  registration(options: PublicKeyCredentialCreationOptionsJSON, changes: { origin?: string; rpId?: string; challenge?: string; verified?: boolean; crossOrigin?: boolean } = {}): RegistrationResponseJSON {
    this.handle = options.user.id;
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    const publicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1,2], [3,-7], [-1,1], [-2,Uint8Array.from(Buffer.from(jwk.x!, 'base64url'))], [-3,Uint8Array.from(Buffer.from(jwk.y!, 'base64url'))],
    ]));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.credential.length);
    const authenticatorData = Buffer.concat([createHash('sha256').update(changes.rpId ?? options.rp.id!).digest(),
      Buffer.from([changes.verified === false ? 0x41 : 0x45]), Buffer.alloc(4), Buffer.alloc(16), length, this.credential, publicKey]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: changes.challenge ?? options.challenge,
      origin: changes.origin ?? this.origin, crossOrigin: changes.crossOrigin ?? false }));
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
      ['fmt','none'], ['attStmt',new Map()], ['authData',Uint8Array.from(authenticatorData)],
    ]));
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: { credProps: { rk: true } },
      response: { clientDataJSON: clientData.toString('base64url'), attestationObject: Buffer.from(attestation).toString('base64url'), transports: ['internal'] } };
  }
  assertion(options: PublicKeyCredentialRequestOptionsJSON, changes: { origin?: string; rpId?: string; challenge?: string; verified?: boolean; counter?: number; userHandle?: string; crossOrigin?: boolean; invalidSignature?: boolean } = {}): AuthenticationResponseJSON {
    const count = Buffer.alloc(4); count.writeUInt32BE(changes.counter ?? ++this.counter);
    const authenticatorData = Buffer.concat([createHash('sha256').update(changes.rpId ?? options.rpId!).digest(), Buffer.from([changes.verified === false ? 1 : 5]), count]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: changes.challenge ?? options.challenge,
      origin: changes.origin ?? this.origin, crossOrigin: changes.crossOrigin ?? false }));
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]), this.key.privateKey);
    if (changes.invalidSignature) signature[signature.length - 1] = signature[signature.length - 1]! ^ 1;
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'), userHandle: changes.userHandle ?? this.handle } };
  }
}
