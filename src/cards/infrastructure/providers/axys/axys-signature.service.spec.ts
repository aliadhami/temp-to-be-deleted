import { createHash, createVerify, generateKeyPairSync } from 'node:crypto';
import { AxysSignatureService } from './axys-signature.service';

describe('AxysSignatureService', () => {
  let service: AxysSignatureService;
  let privateKeyPem: string;
  let publicKeyPem: string;

  beforeAll(() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    privateKeyPem = privateKey
      .export({ type: 'pkcs1', format: 'pem' })
      .toString();
    publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  });

  beforeEach(() => {
    service = new AxysSignatureService();
  });

  const verifyAgainstPublicKey = (
    method: string,
    pathWithQuery: string,
    rawBody: string,
    headers: {
      'X-Timestamp': string;
      'X-Nonce': string;
      'X-Signature': string;
    },
  ): boolean => {
    const bodyHash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
    const canonical = [
      method.toUpperCase(),
      pathWithQuery,
      headers['X-Timestamp'],
      headers['X-Nonce'],
      bodyHash,
    ].join('\n');
    const verifier = createVerify('RSA-SHA256').update(canonical);
    return verifier.verify(publicKeyPem, headers['X-Signature'], 'base64');
  };

  it('produces a signature that independently verifies against the public key', () => {
    const headers = service.sign('GET', '/accounts', '', privateKeyPem);
    expect(verifyAgainstPublicKey('GET', '/accounts', '', headers)).toBe(true);
  });

  it('produces a signature that verifies correctly for a POST with a body', () => {
    const body = JSON.stringify({ first_name: 'Jordan' });
    const headers = service.sign('POST', '/accounts', body, privateKeyPem);
    expect(verifyAgainstPublicKey('POST', '/accounts', body, headers)).toBe(
      true,
    );
  });

  it('fails verification if the path is altered after signing', () => {
    const headers = service.sign('GET', '/accounts', '', privateKeyPem);
    expect(
      verifyAgainstPublicKey('GET', '/accounts/tampered', '', headers),
    ).toBe(false);
  });

  it('fails verification if the body is altered after signing', () => {
    const headers = service.sign('POST', '/accounts', '{"a":1}', privateKeyPem);
    expect(
      verifyAgainstPublicKey('POST', '/accounts', '{"a":2}', headers),
    ).toBe(false);
  });

  it('generates a nonce within the spec-required 16-128 character range', () => {
    const headers = service.sign('GET', '/accounts', '', privateKeyPem);
    expect(headers['X-Nonce'].length).toBeGreaterThanOrEqual(16);
    expect(headers['X-Nonce'].length).toBeLessThanOrEqual(128);
  });

  it('generates a fresh nonce and timestamp on every call — never reused', () => {
    const first = service.sign('GET', '/accounts', '', privateKeyPem);
    const second = service.sign('GET', '/accounts', '', privateKeyPem);
    expect(first['X-Nonce']).not.toBe(second['X-Nonce']);
  });
});
