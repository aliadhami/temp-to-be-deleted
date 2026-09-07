import {
  constants,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  privateDecrypt,
} from 'node:crypto';

/**
 * The RSA half of their "Bank card detail-v2" endpoint: we send a public key
 * on the request, they encrypt the card's details under it, and we decrypt
 * here.
 */

/**
 * The smallest modulus their page permits, stated for their longest plaintext
 * and applied to every obtain way here — a product's obtain way is a setting
 * on their side that can change without a deploy of ours, so a key large
 * enough for the longest payload is large enough for all of them.
 */
export const HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS = 4096;

/**
 * The padding their encryption uses. Undocumented on their site, confirmed
 * against their server and then by their integration team, and passed
 * explicitly because none of that is visible from the call site.
 */
const CARD_DETAIL_PADDING = constants.RSA_PKCS1_PADDING;

/** What a reader who has just met an unreadable card detail needs to know. */
export const HYPERCARD_CARD_DETAIL_PADDING_NOTE =
  'This decrypt uses PKCS#1 v1.5 padding, confirmed against their server and by their integration team, who undertook to version rather than silently change it. A mismatched scheme does not raise, and a mismatched key usually does not either — OpenSSL implicitly rejects a bad PKCS#1 v1.5 decryption by returning pseudorandom bytes — so an unreadable payload is the symptom to expect. The exception is a key whose modulus is larger than ours, which can produce a ciphertext this key will not attempt at all; that raises here instead. Either way the key this request sent is the thing to check before the scheme.';

/** Raised by anything here that cannot do its job. Never carries key or card material. */
export class HyperCardCardDetailCryptoError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = 'HyperCardCardDetailCryptoError';
  }
}

/**
 * Reads a PEM private key and refuses anything that could not serve this
 * endpoint.
 */
export const loadHyperCardCardDetailKey = (pem: string): KeyObject => {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    // The reason is the parser's ("no start line", "unsupported"), which names
    // no key material — but the PEM itself never appears here either way.
    throw new HyperCardCardDetailCryptoError(
      'HyperCard card-detail key could not be read as a PEM private key',
      { cause: error },
    );
  }

  if (key.asymmetricKeyType !== 'rsa') {
    throw new HyperCardCardDetailCryptoError(
      `HyperCard card-detail key must be RSA, not "${String(key.asymmetricKeyType)}" — their endpoint encrypts the card detail under an RSA public key`,
    );
  }

  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS) {
    throw new HyperCardCardDetailCryptoError(
      `HyperCard card-detail key is ${modulusLength}-bit; their page requires at least ${HYPERCARD_CARD_DETAIL_MIN_MODULUS_BITS}. Point this at its own key, not at the RSA-1024 signing key.`,
    );
  }

  return key;
};

/**
 * The public half, in the form their request field takes: base64 of the DER
 * SubjectPublicKeyInfo, with no PEM header, footer or newlines.
 */
export const deriveHyperCardCardDetailPublicKey = (
  privateKey: KeyObject,
): string =>
  createPublicKey(privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');

/** Their `encoded_card_detail` as the plaintext they encrypted. */
export const decryptHyperCardCardDetail = (
  privateKey: KeyObject,
  encodedCardDetail: string,
): string => {
  let ciphertext: Buffer;
  try {
    ciphertext = Buffer.from(encodedCardDetail, 'base64');
  } catch (error) {
    throw new HyperCardCardDetailCryptoError(
      'HyperCard returned a card detail that is not base64',
      { cause: error },
    );
  }

  if (ciphertext.length === 0) {
    throw new HyperCardCardDetailCryptoError(
      'HyperCard returned an empty encrypted card detail',
    );
  }

  let plaintext: Buffer;
  try {
    plaintext = privateDecrypt(
      { key: privateKey, padding: CARD_DETAIL_PADDING },
      ciphertext,
    );
  } catch (error) {
    // Reached only by a ciphertext OpenSSL will not even attempt — one that
    // is not smaller than this modulus, whether over-long or encrypted under a
    // larger foreign modulus. A mismatched padding, or a key no larger than
    // ours, lands in the caller's parse failure instead, which carries the
    // same note.
    throw new HyperCardCardDetailCryptoError(
      `HyperCard card detail could not be decrypted. ${HYPERCARD_CARD_DETAIL_PADDING_NOTE}`,
      { cause: error },
    );
  }

  return plaintext.toString('utf8');
};
