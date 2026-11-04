import { sessionRequest } from './browser-transport.js';

function binary(value: string) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
    c.charCodeAt(0),
  );
}
function base64(value: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export async function passkey(enrollmentTicket?: string) {
  const registering = !!enrollmentTicket,
    base = '/api/v1/identity/' + (registering ? 'register' : 'signin');
  const start = await sessionRequest<{
    challenge_id: string;
    options: Record<string, unknown>;
  }>(base + '/start', {
    body: registering ? { ticket: enrollmentTicket } : {},
  });
  const json = start.options;
  const publicKey = {
    ...json,
    challenge: binary(json.challenge as string),
    ...(registering
      ? {
          user: {
            ...(json.user as object),
            id: binary((json.user as { id: string }).id),
          },
          excludeCredentials: ((json.excludeCredentials ?? []) as { id: string }[]).map((item) => ({
            ...item,
            id: binary(item.id),
          })),
        }
      : {
          allowCredentials: ((json.allowCredentials ?? []) as { id: string }[]).map((item) => ({
            ...item,
            id: binary(item.id),
          })),
        }),
  };
  const credential = (
    registering
      ? await navigator.credentials.create({
          publicKey: publicKey as unknown as PublicKeyCredentialCreationOptions,
        })
      : await navigator.credentials.get({
          publicKey: publicKey as unknown as PublicKeyCredentialRequestOptions,
        })
  ) as PublicKeyCredential | null;
  if (!credential) throw new Error('The passkey ceremony was not completed.');
  const response = credential.response;
  const encoded = {
    id: credential.id,
    rawId: base64(credential.rawId),
    type: 'public-key',
    clientExtensionResults: credential.getClientExtensionResults(),
    response: registering
      ? {
          clientDataJSON: base64(response.clientDataJSON),
          attestationObject: base64(
            (response as AuthenticatorAttestationResponse).attestationObject,
          ),
          transports: (response as AuthenticatorAttestationResponse).getTransports(),
        }
      : {
          clientDataJSON: base64(response.clientDataJSON),
          authenticatorData: base64((response as AuthenticatorAssertionResponse).authenticatorData),
          signature: base64((response as AuthenticatorAssertionResponse).signature),
          ...((response as AuthenticatorAssertionResponse).userHandle
            ? {
                userHandle: base64((response as AuthenticatorAssertionResponse).userHandle!),
              }
            : {}),
        },
  };
  await sessionRequest(base + '/finish', {
    body: { challenge_id: start.challenge_id, response: encoded },
  });
}
