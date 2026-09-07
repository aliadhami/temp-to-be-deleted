import { CardProviderIntentRejectedError } from '../../../domain/card-provider-intent-rejected.error';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { CardholderIntent } from '../../../domain/cardholder-intent.model';

/**
 * The constraints HyperCard puts on the `base_info` container their card
 * application carries, checked against a staged cardholder.
 */

/** Their page: maximum 50 characters, letters and whitespace only. */
const NAME_PATTERN = /^[a-zA-Z\s]+$/;
const NAME_MAX_LENGTH = 50;

/**
 * Their page's regex for an address, with one deliberate difference: the outer
 * repetition around the domain is removed. Theirs is the classic `(a+)+`
 * shape.
 */
const EMAIL_PATTERN =
  /^[0-9a-zA-Z_]+([_.-][0-9a-zA-Z_]+)*@[0-9a-zA-Z_]+([.-][0-9a-zA-Z_]+)*\.[a-z]{2,}$/;
const EMAIL_MAX_LENGTH = 64;

/** Their page: minimum 6 characters, maximum 11. */
const MOBILE_MIN_LENGTH = 6;
const MOBILE_MAX_LENGTH = 11;

/**
 * Only the shape is checked, deliberately: an allowlist transcribed from a
 * provider's two-hundred-row table refuses the first entry they add to it. An
 * unlisted-but-well-formed code is left for them to refuse.
 */
const MOBILE_CODE_PATTERN = /^\d{1,4}$/;

const reject = (field: string, reason: string): never => {
  throw new CardProviderIntentRejectedError(
    CardProviderKey.HYPERCARD,
    field,
    reason,
  );
};

/**
 * Refuses a cardholder HyperCard's application endpoints would not accept. A
 * guard: the caller reads the intent's fields directly afterwards.
 */
export const assertHyperCardBaseInfo = (intent: CardholderIntent): void => {
  for (const [field, value] of [
    ['firstName', intent.firstName],
    ['lastName', intent.lastName],
  ] as const) {
    if (!NAME_PATTERN.test(value)) {
      reject(
        field,
        'this issuer accepts only letters and spaces in a name, so an accent, apostrophe, hyphen or digit is refused',
      );
    }

    if (value.length > NAME_MAX_LENGTH) {
      reject(
        field,
        `this issuer accepts at most ${NAME_MAX_LENGTH} characters and this is ${value.length}`,
      );
    }
  }

  if (intent.email.length > EMAIL_MAX_LENGTH) {
    reject(
      'email',
      `this issuer accepts at most ${EMAIL_MAX_LENGTH} characters and this is ${intent.email.length}`,
    );
  }
  if (!EMAIL_PATTERN.test(intent.email)) {
    reject(
      'email',
      "this issuer's address format is narrower than a general one — it takes letters, digits and underscores, separated by single dots or hyphens",
    );
  }

  const mobile = intent.identityProvenance.cellNumber;
  if (mobile.length < MOBILE_MIN_LENGTH || mobile.length > MOBILE_MAX_LENGTH) {
    reject(
      'identityProvenance.cellNumber',
      `this issuer accepts between ${MOBILE_MIN_LENGTH} and ${MOBILE_MAX_LENGTH} characters and this is ${mobile.length}`,
    );
  }

  if (!MOBILE_CODE_PATTERN.test(intent.identityProvenance.callingCode)) {
    reject(
      'identityProvenance.callingCode',
      'this issuer takes a dialling code of up to four digits, with no leading plus',
    );
  }
};
