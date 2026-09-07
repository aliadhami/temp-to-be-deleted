import { CardProductApplicationMode } from '../../../domain/card-product-application-mode.enum';
import { CardProviderKey } from '../../../domain/card-provider-key.enum';
import { CardProviderUnsupportedApplicationModeError } from '../../../domain/card-provider-unsupported-application-mode.error';

/**
 * Their "Application (Express)-v4" endpoint — the one application path this
 * integration sends.
 */
const EXPRESS_APPLICATION_PATH = '/v4/openapi/card/apply/quick';

/**
 * Which of their application endpoints serves each mode, or `null` where they
 * publish one and this integration does not send it.
 */
const APPLICATION_PATH_BY_MODE: Record<
  CardProductApplicationMode,
  string | null
> = {
  [CardProductApplicationMode.NO_KYC]: EXPRESS_APPLICATION_PATH,

  /**
   * Their documents-inline application. Not sent: the identity material has no
   * home on this codebase's issuance request, and the review it triggers has
   * no home in the cardholder status this integration reports — see below.
   */
  [CardProductApplicationMode.FULL_KYC]: null,

  /**
   * Their binding flow, which links a card the holder already physically has.
   * Two calls with identity material on the second, so it is not an
   * application path at all — it fits the onboard-then-submit-KYC shape, not
   * the issuance one.
   */
  [CardProductApplicationMode.PREISSUED_CARD]: null,

  /** Documents inline plus a billing address, which nothing here models. */
  [CardProductApplicationMode.KYC_WITH_BILLING_ADDRESS]: null,

  /** Documents inline again; what distinguishes it is an open question. */
  [CardProductApplicationMode.ONLINE_KYC]: null,
};

/**
 * The modes this integration does send, derived from the table above rather
 * than listed again — a second list is one a later change can widen the table
 * without touching, leaving the refusal naming a mode that is still refused.
 */
const SUPPORTED_APPLICATION_MODES: readonly CardProductApplicationMode[] = (
  Object.keys(APPLICATION_PATH_BY_MODE) as CardProductApplicationMode[]
).filter((mode) => APPLICATION_PATH_BY_MODE[mode] !== null);

/**
 * Picks the application endpoint for a resolved product's application mode,
 * and refuses every mode this integration does not send. The refusal is load-
 * bearing, not a placeholder — read this before widening the table above.
 */
export const resolveHyperCardApplicationPath = (
  mode: CardProductApplicationMode,
): string => {
  // `Object.hasOwn` rather than a plain lookup, which reads through the
  // prototype: `toString`, `constructor` and `valueOf` all return an inherited
  // function, which is neither null nor undefined and would sail past the
  // guard below to be sent as a URL path.
  const path = Object.hasOwn(APPLICATION_PATH_BY_MODE, mode)
    ? APPLICATION_PATH_BY_MODE[mode]
    : null;

  if (path === null) {
    throw new CardProviderUnsupportedApplicationModeError(
      CardProviderKey.HYPERCARD,
      String(mode),
      SUPPORTED_APPLICATION_MODES,
    );
  }

  return path;
};
