import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  publicEncrypt,
} from 'node:crypto';
import {
  decryptHyperCardCardDetail,
  deriveHyperCardCardDetailPublicKey,
  HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS,
  HyperCardCardDetailCryptoError,
  loadHyperCardCardDetailKey,
} from './hypercard-card-detail.crypto';

/**
 * Their own published `pub_key` example, from their "Bank card detail-v2"
 * page.
 */
const THEIR_EXAMPLE_PUB_KEY =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC37by7wUaaPgE0ljdw3F/8OX6qzcX6rKzcmCtn2cKHbuZ+ynPGgFZX5lqlEEKdXI8sBEuqtxU+0G+eRlmTtSAqqytF0K0rM50mKGfF2hPw//Z4ajKymsRghdiUPXJ6AxN8oyY15l1uMZcD0Ru0/OQp7VdSLNtZmKDOMhm9GeodAwIDAQAB';

const keyPairPem = (modulusLength: number): string =>
  generateKeyPairSync('rsa', {
    modulusLength,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

/** Encrypts the way their server is assumed to — see the padding note in the source. */
const encryptAsTheyWould = (
  publicKeyBase64: string,
  plaintext: string,
): string =>
  publicEncrypt(
    {
      key: createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      }),
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(plaintext, 'utf8'),
  ).toString('base64');

/**
 * A key's RSA modulus as an integer. Two keys of the same bit length are not
 * ordered by that bit length, so comparing sizes needs the modulus itself.
 */
const modulusOf = (key: KeyObject): bigint => {
  const { n } = createPublicKey(key).export({ format: 'jwk' });

  if (n === undefined) {
    throw new Error('expected an RSA key, whose JWK carries a modulus');
  }

  return BigInt(`0x${Buffer.from(n, 'base64url').toString('hex')}`);
};

/**
 * A second key of the size their page requires, whose modulus is not larger
 * than `key`'s — so every ciphertext it produces lies in a range `key` will
 * attempt to decrypt. Roughly half the candidates qualify, so this generates
 * twice on average; the test's own timeout bounds the tail.
 */
const foreignKeyNoLargerThan = (key: KeyObject): KeyObject => {
  const ceiling = modulusOf(key);

  for (;;) {
    const candidate = loadHyperCardCardDetailKey(
      keyPairPem(HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS),
    );

    if (modulusOf(candidate) <= ceiling) {
      return candidate;
    }
  }
};

describe('HyperCard card-detail crypto', () => {
  // Generated once: a 4096-bit keypair is the smallest their page permits, and
  // generating one per case would pay for it a dozen times over.
  let privateKey: KeyObject;
  let publicKeyBase64: string;

  beforeAll(() => {
    privateKey = loadHyperCardCardDetailKey(
      keyPairPem(HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS),
    );
    publicKeyBase64 = deriveHyperCardCardDetailPublicKey(privateKey);
  });

  describe('loadHyperCardCardDetailKey', () => {
    it('refuses a key below the size their page requires', () => {
      // Their signing keypair is RSA-1024, and pointing this variable at it is
      // the single most available mistake — so the refusal names the size.
      expect(() => loadHyperCardCardDetailKey(keyPairPem(1024))).toThrow(
        HyperCardCardDetailCryptoError,
      );
      expect(() => loadHyperCardCardDetailKey(keyPairPem(1024))).toThrow(
        /1024-bit.*at least 4096/,
      );
    });

    it('refuses something that is not a PEM private key, without echoing it', () => {
      const attempt = (): KeyObject =>
        loadHyperCardCardDetailKey('-----BEGIN RSA PRIVATE KEY-----\nnope\n');

      expect(attempt).toThrow(HyperCardCardDetailCryptoError);
      // The value itself must not travel in the message. `nope` stands in for
      // key material here: a real failure carries a real key.
      expect(attempt).not.toThrow(/nope/);
    });
  });

  describe('deriveHyperCardCardDetailPublicKey', () => {
    it('produces base64 DER SubjectPublicKeyInfo, matching the form of their own example', () => {
      // Their example is the reference for the *shape*, not the size — theirs
      // is 1024-bit, which their own note forbids for this request.
      expect(() =>
        createPublicKey({
          key: Buffer.from(THEIR_EXAMPLE_PUB_KEY, 'base64'),
          format: 'der',
          type: 'spki',
        }),
      ).not.toThrow();

      const decoded = createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });

      // No PEM header, footer or newline — their merchant documentation asks
      // for the key with all three stripped.
      expect(publicKeyBase64).not.toMatch(/BEGIN|-----|\n/);
      expect(decoded.asymmetricKeyDetails?.modulusLength).toBe(
        HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS,
      );
    });

    it('derives the public half of the key it was given, not some other key', () => {
      // The whole reason the public key is derived rather than configured
      // beside the private one: two paths that must agree can disagree.
      const other = deriveHyperCardCardDetailPublicKey(
        loadHyperCardCardDetailKey(
          keyPairPem(HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS),
        ),
      );

      expect(other).not.toBe(publicKeyBase64);
      expect(
        decryptHyperCardCardDetail(
          privateKey,
          encryptAsTheyWould(publicKeyBase64, 'round trip'),
        ),
      ).toBe('round trip');
    });
  });

  describe('decryptHyperCardCardDetail', () => {
    it('recovers their documented virtual-card payload byte for byte', () => {
      // Their own example plaintext, from their "Bank card detail-v2" page.
      const theirPayload =
        '{"cvv":"123","card_number":"1001022400001101","expire":"04/2025"}';

      expect(
        decryptHyperCardCardDetail(
          privateKey,
          encryptAsTheyWould(publicKeyBase64, theirPayload),
        ),
      ).toBe(theirPayload);
    });

    it('recovers their hosted-page payload, which is the longest of the four', () => {
      // The payload their 4096-bit requirement exists for.
      const theirPayload =
        '{"url":"https://www.test.com/card?card?8888888888888888", "password":"888888", "expires_at":"1772712803","expires_in":"3600"}';

      expect(
        decryptHyperCardCardDetail(
          privateKey,
          encryptAsTheyWould(publicKeyBase64, theirPayload),
        ),
      ).toBe(theirPayload);
    });

    /**
     * A wrong padding scheme does not raise, and that is measured here rather
     * than assumed.
     */
    it('returns pseudorandom bytes rather than raising when the scheme was wrong', () => {
      const wrongScheme = publicEncrypt(
        {
          key: createPublicKey({
            key: Buffer.from(publicKeyBase64, 'base64'),
            format: 'der',
            type: 'spki',
          }),
          padding: constants.RSA_PKCS1_OAEP_PADDING,
        },
        Buffer.from('{"cvv":"123"}', 'utf8'),
      ).toString('base64');

      const output = decryptHyperCardCardDetail(privateKey, wrongScheme);

      expect(output).not.toContain('cvv');
    });

    it('returns pseudorandom bytes rather than raising when the key was wrong, and that key was no larger', () => {
      // The size qualifier is the whole point of choosing the foreign key
      // rather than taking any second key. An RSA ciphertext is roughly
      // uniform below the encrypting modulus, and two independent 4096-bit
      // moduli both sit in [2^4095, 2^4096) — so a foreign key is the larger
      // one about half the time, and some of its ciphertexts then land above
      // ours, which OpenSSL refuses outright instead of implicitly rejecting.
      // Any second key would make this assert implicit rejection on a case
      // that raises roughly one run in ten.
      const foreign = deriveHyperCardCardDetailPublicKey(
        foreignKeyNoLargerThan(privateKey),
      );

      const output = decryptHyperCardCardDetail(
        privateKey,
        encryptAsTheyWould(foreign, '{"cvv":"123"}'),
      );

      expect(output).not.toContain('cvv');
      // The larger-modulus case is the raise measured below, reached there by
      // a ciphertext too long rather than by a foreign key, because generating
      // one that lands in the gap between two close moduli is unbounded work.
    }, 30_000);

    it('refuses an empty detail rather than returning an empty string', () => {
      expect(() => decryptHyperCardCardDetail(privateKey, '')).toThrow(
        /empty encrypted card detail/,
      );
    });

    it('does not swallow the failure OpenSSL does raise, and names the scheme it assumed', () => {
      // OpenSSL refuses outright, rather than implicitly rejecting, a
      // ciphertext that is not smaller than the modulus — over-long like this
      // one, or the same length but encrypted under a larger foreign modulus.
      // That is the only shape of decryption failure that surfaces here, and
      // it still has to carry the padding note — the same note the parse
      // failure carries, since a reader meeting either needs it.
      const oversized = Buffer.alloc(1024, 7).toString('base64');

      expect(() => decryptHyperCardCardDetail(privateKey, oversized)).toThrow(
        HyperCardCardDetailCryptoError,
      );
      // Asserted on the scheme and on the first thing to check, not on the
      // whole sentence: the note is prose that will be reworded, and pinning it
      // verbatim makes a spec that fails on an edit rather than on a defect.
      expect(() => decryptHyperCardCardDetail(privateKey, oversized)).toThrow(
        /PKCS#1 v1\.5 padding/,
      );
      expect(() => decryptHyperCardCardDetail(privateKey, oversized)).toThrow(
        /the key this request sent/,
      );
    });
  });
});
