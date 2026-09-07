import { Logger } from '@nestjs/common';
import { CardLifecycleOperation } from '../../../domain/card-lifecycle-operation.enum';
import { CardMaterial } from '../../../domain/card-material.enum';
import { CardOrganisation } from '../../../domain/card-organisation.enum';
import { CardProductActivationMode } from '../../../domain/card-product-activation-mode.enum';
import { CardProductApplicationMode } from '../../../domain/card-product-application-mode.enum';
import { CardProductSensitiveDetailMode } from '../../../domain/card-product-sensitive-detail-mode.enum';
import { CardProductListing } from '../../../domain/card-issuer.port';
import {
  CardProduct,
  CardProductActivation,
  CardProductFee,
} from '../../../domain/card-product.model';
import { CardType } from '../../../domain/card-type.enum';
import {
  isZeroHyperCardAmount,
  normaliseHyperCardAmount,
  normaliseHyperCardInteger,
  normaliseHyperCardText,
} from './hypercard-coercion.util';
import {
  HYPERCARD_FLAG_YES,
  HyperCardActivateType,
  HyperCardApplyType,
  HyperCardCardDetailObtainWay,
  HyperCardCardOrg,
  HyperCardCardProductRow,
  HyperCardCardSubType,
  HyperCardCardType,
  HyperCardOperationType,
} from './hypercard.types';

const logger = new Logger('HyperCardCardProductMapper');

/**
 * The currency their card-opening and annual fees are billed in — not the
 * card's own currency, which is why every fee on the domain model carries one.
 */
const FEE_CURRENCY_CODE = 'USDT';

/** How far right the decimal point moves to turn their fraction into percent units. */
const PERCENT_DECIMAL_PLACES = 2;

/**
 * Moves a decimal string's point right, by string surgery rather than
 * multiplication: `0.028 * 100` is `2.8000000000000003` in IEEE-754, and that
 * would be persisted and shown to a partner as their fee.
 */
const shiftDecimalPointRight = (amount: string, places: number): string => {
  const [whole = '', fraction = ''] = amount.split('.');

  // Padding first means a fraction shorter than the shift still works:
  // '0.5' shifted two places is '50', not '5.'.
  const padded = fraction.padEnd(places, '0');
  const shiftedWhole = `${whole}${padded.slice(0, places)}`.replace(
    // Leading zeros only, and never the last digit — '002' is '2', '0' stays.
    /^0+(?=\d)/,
    '',
  );
  const shiftedFraction = padded.slice(places);

  return shiftedFraction === ''
    ? shiftedWhole
    : `${shiftedWhole}.${shiftedFraction}`;
};

/**
 * A fee, or null when the issuer charges none. A published zero reads the same
 * as an absent field — the domain model's null already means free, and
 * carrying `'0.00000000'` through would give a partner two spellings of it.
 */
const toFee = (raw: unknown, currencyCode: string): CardProductFee | null => {
  const amount = normaliseHyperCardAmount(raw);
  if (amount === null || isZeroHyperCardAmount(amount)) return null;
  return { amount, currencyCode };
};

/**
 * Their `recharge_fee` as a percentage in percent units — the wire carries a
 * fraction, so `'0.02800000'` becomes `'2.800000'`.
 */
const toDepositFeePercent = (raw: unknown): string | null => {
  const fraction = normaliseHyperCardAmount(raw);
  if (fraction === null || isZeroHyperCardAmount(fraction)) return null;
  return shiftDecimalPointRight(fraction, PERCENT_DECIMAL_PLACES);
};

/**
 * One of their integer booleans, where absent means **no** — correct for
 * `need_first_recharge`.
 */
const isAffirmativeFlag = (raw: unknown): boolean =>
  normaliseHyperCardInteger(raw) === HYPERCARD_FLAG_YES;

/** One of their integer booleans, where absent means yes. */
const isEnabledFlag = (raw: unknown): boolean => {
  if (raw === undefined) return true;
  if (typeof raw === 'string' && raw.trim() === '') return true;
  return normaliseHyperCardInteger(raw) === HYPERCARD_FLAG_YES;
};

/**
 * One of their integer codes, resolved against the table that gives it
 * meaning. Undefined for a code added since this was written *and* for one
 * that is not an integer — the caller treats both the same way.
 */
const lookupCode = <T>(
  table: Readonly<Record<number, T>>,
  raw: unknown,
): T | undefined => {
  const code = normaliseHyperCardInteger(raw);
  return code === null ? undefined : table[code];
};

const CARD_TYPE_BY_CODE: Record<number, CardType> = {
  [HyperCardCardType.VIRTUAL]: CardType.VIRTUAL,
  [HyperCardCardType.PHYSICAL]: CardType.PHYSICAL,
};

const ORGANISATION_BY_CODE: Record<number, CardOrganisation> = {
  [HyperCardCardOrg.VISA]: CardOrganisation.VISA,
  [HyperCardCardOrg.MASTERCARD]: CardOrganisation.MASTERCARD,
  [HyperCardCardOrg.AMERICAN_EXPRESS]: CardOrganisation.AMERICAN_EXPRESS,
  [HyperCardCardOrg.UNIONPAY]: CardOrganisation.UNIONPAY,
  [HyperCardCardOrg.DISCOVER]: CardOrganisation.DISCOVER,
  [HyperCardCardOrg.JCB]: CardOrganisation.JCB,
};

const MATERIAL_BY_CODE: Record<number, CardMaterial> = {
  [HyperCardCardSubType.METAL]: CardMaterial.METAL,
  [HyperCardCardSubType.PLASTIC]: CardMaterial.PLASTIC,
};

const APPLICATION_MODE_BY_CODE: Record<number, CardProductApplicationMode> = {
  [HyperCardApplyType.DEFAULT]: CardProductApplicationMode.FULL_KYC,
  [HyperCardApplyType.EXPRESS]: CardProductApplicationMode.NO_KYC,
  [HyperCardApplyType.BINDING]: CardProductApplicationMode.PREISSUED_CARD,
  [HyperCardApplyType.BILLING]:
    CardProductApplicationMode.KYC_WITH_BILLING_ADDRESS,
  [HyperCardApplyType.ONLINE]: CardProductApplicationMode.ONLINE_KYC,
};

const ACTIVATION_BY_CODE: Record<number, CardProductActivation> = {
  [HyperCardActivateType.API_WITH_DOCUMENT]: {
    mode: CardProductActivationMode.ISSUER_REQUEST,
    requiresIdentityDocument: true,
  },
  [HyperCardActivateType.EMAIL]: {
    mode: CardProductActivationMode.CARDHOLDER_DIRECT,
  },
  /**
   * Their docs describe no endpoint for this one — their Activation page
   * restricts itself to a different activate type, so a product they name "via
   * API (no need ID)" has no API to call.
   */
  [HyperCardActivateType.API_WITHOUT_DOCUMENT]: {
    mode: CardProductActivationMode.ISSUER_REQUEST,
    requiresIdentityDocument: false,
  },
};

const SENSITIVE_DETAIL_MODE_BY_CODE: Record<
  number,
  CardProductSensitiveDetailMode
> = {
  [HyperCardCardDetailObtainWay.API]: CardProductSensitiveDetailMode.API,
  [HyperCardCardDetailObtainWay.HOSTED_PAGE]:
    CardProductSensitiveDetailMode.HOSTED_PAGE,
  [HyperCardCardDetailObtainWay.EMAIL]:
    CardProductSensitiveDetailMode.CARDHOLDER_DIRECT,
};

/** Their "Operation Type" appendix, in full. */
const OPERATION_BY_CODE: Record<number, CardLifecycleOperation> = {
  [HyperCardOperationType.FREEZE]: CardLifecycleOperation.BLOCK,
  [HyperCardOperationType.UNFREEZE]: CardLifecycleOperation.UNBLOCK,
  [HyperCardOperationType.REPORT_LOSS]: CardLifecycleOperation.REPORT_LOSS,
  [HyperCardOperationType.RESET_PASSWORD]:
    CardLifecycleOperation.RESET_PASSWORD,
  [HyperCardOperationType.CARD_REISSUE]: CardLifecycleOperation.REISSUE,
  [HyperCardOperationType.RESEND_OR_RESET_PIN]:
    CardLifecycleOperation.CHANGE_PIN,
  [HyperCardOperationType.CANCEL_CARD]: CardLifecycleOperation.CANCEL,
};

/**
 * Network names as a person writes them. Their response carries no name field,
 * so `displayName` is composed here — a raw enum member would put
 * `AMERICAN_EXPRESS` in front of a partner.
 */
const ORGANISATION_LABELS: Record<CardOrganisation, string> = {
  [CardOrganisation.VISA]: 'Visa',
  [CardOrganisation.MASTERCARD]: 'Mastercard',
  [CardOrganisation.AMERICAN_EXPRESS]: 'American Express',
  [CardOrganisation.UNIONPAY]: 'UnionPay',
  [CardOrganisation.DISCOVER]: 'Discover',
  [CardOrganisation.JCB]: 'JCB',
};

const CARD_TYPE_LABELS: Record<CardType, string> = {
  [CardType.VIRTUAL]: 'Virtual',
  [CardType.PHYSICAL]: 'Physical',
};

/**
 * `"Visa Virtual USD"` — network, form, currency. Deliberately not the
 * material: their own example pairs a metal material with a virtual card type,
 * which would produce "Visa Metal Virtual USD".
 */
const composeDisplayName = (
  organisation: CardOrganisation,
  cardType: CardType,
  currencyCode: string,
): string =>
  `${ORGANISATION_LABELS[organisation]} ${CARD_TYPE_LABELS[cardType]} ${currencyCode}`;

const describeRow = (row: HyperCardCardProductRow): string =>
  row.card_type_id === undefined
    ? '<no card type id>'
    : String(row.card_type_id);

/**
 * The unknown branch: warn, and drop the product. Dropping rather than
 * defaulting is the point.
 */
const exclude = (row: HyperCardCardProductRow, reason: string): null => {
  logger.warn(
    `Excluding HyperCard card product ${describeRow(row)} from the catalogue: ${reason}. ` +
      `Check their "Card config list" page and the matching appendix for a value added since this mapper was written.`,
  );
  return null;
};

/**
 * How a card issued against this product will later be read, or null when they
 * publish nothing this mapper can place. The only unknown branch here that
 * does not exclude the product.
 */
const resolveSensitiveDetailMode = (
  row: HyperCardCardProductRow,
): CardProductSensitiveDetailMode | null => {
  if (row.card_detail_obtain_way === undefined) return null;

  const mode = lookupCode(
    SENSITIVE_DETAIL_MODE_BY_CODE,
    row.card_detail_obtain_way,
  );
  if (mode !== undefined) return mode;

  logger.warn(
    `HyperCard card product ${describeRow(row)} carries an unrecognised card_detail_obtain_way "${String(row.card_detail_obtain_way)}" — listing the product without a sensitive-detail mode. ` +
      `Check their "Card config list" page for a value added since this mapper was written.`,
  );
  return null;
};

/**
 * Which operations the product accepts, from their comma-separated
 * `support_business`.
 *
 * Absent or unreadable is an **empty array, never every operation** — their
 * field has no documented default, and reading absence as permission would
 * offer a partner an operation the issuer never published.
 *
 * An unnameable code drops the member and keeps the product, inverting the
 * unrecognised-configuration branches above.
 */
const mapSupportedOperations = (
  row: HyperCardCardProductRow,
): CardLifecycleOperation[] => {
  const list = normaliseHyperCardText(row.support_business);
  if (list === null) return [];

  const operations: CardLifecycleOperation[] = [];

  for (const member of list.split(',')) {
    // An empty member names no code, so there is nothing to warn about.
    if (member.trim() === '') continue;

    const operation = lookupCode(OPERATION_BY_CODE, member);
    if (operation === undefined) {
      logger.warn(
        `HyperCard card product ${describeRow(row)} supports operation "${member.trim()}", which this mapper cannot name — listing the product without it. ` +
          `Check their "Operation Type" appendix for a code added since this was written; their numbering leaves 7 and 8 free.`,
      );
      continue;
    }

    if (!operations.includes(operation)) operations.push(operation);
  }

  return operations;
};

/**
 * One of their catalogue rows, normalised — or null when it carries something
 * this mapper cannot read.
 */
export const mapHyperCardCardProduct = (
  row: HyperCardCardProductRow,
): CardProduct | null => {
  const providerProductId = normaliseHyperCardText(row.card_type_id);
  if (providerProductId === null) {
    return exclude(row, 'it carries no card type id to key it on');
  }

  const cardType = lookupCode(CARD_TYPE_BY_CODE, row.card_type);
  if (cardType === undefined) {
    return exclude(row, `unrecognised card type "${String(row.card_type)}"`);
  }

  const cardOrganisation = lookupCode(ORGANISATION_BY_CODE, row.card_org);
  if (cardOrganisation === undefined) {
    return exclude(
      row,
      `unrecognised card organisation "${String(row.card_org)}"`,
    );
  }

  // The one field whose absence is not an exclusion: no material published is
  // a real, documented state, so it maps to null and only a *present*
  // unrecognised code excludes the row.
  const material =
    row.card_sub_type === undefined
      ? null
      : lookupCode(MATERIAL_BY_CODE, row.card_sub_type);
  if (material === undefined) {
    return exclude(
      row,
      `unrecognised card material "${String(row.card_sub_type)}"`,
    );
  }

  const applicationMode = lookupCode(APPLICATION_MODE_BY_CODE, row.apply_type);
  if (applicationMode === undefined) {
    return exclude(
      row,
      `unrecognised application type "${String(row.apply_type)}"`,
    );
  }

  const activation = lookupCode(ACTIVATION_BY_CODE, row.activate_type);
  if (activation === undefined) {
    return exclude(
      row,
      `unrecognised activation method "${String(row.activate_type)}"`,
    );
  }

  // Uppercased here because the domain model says normalising case is the
  // adapter's job: HyperCard sends 'usd', and a partner comparing against 'USD'
  // would otherwise match one provider and miss this one.
  const cardCoin = normaliseHyperCardText(row.card_coin);
  if (cardCoin === null) {
    return exclude(row, 'it carries no card currency');
  }
  const currencyCode = cardCoin.toUpperCase();

  return {
    providerProductId,
    displayName: composeDisplayName(cardOrganisation, cardType, currencyCode),
    cardType,
    cardOrganisation,
    material,
    currencyCode,
    fees: {
      issuance: toFee(row.card_fee, FEE_CURRENCY_CODE),
      annual: toFee(row.annual_fee, FEE_CURRENCY_CODE),
      depositFeePercent: toDepositFeePercent(row.recharge_fee),
    },
    depositLimits: {
      // A published zero is kept here, unlike a fee: the model says a null
      // limit means the issuer states none, which is not the same as a limit
      // of zero, so collapsing the two would lose a distinction it draws
      // deliberately.
      minPerTransaction: normaliseHyperCardAmount(
        row.min_single_recharge_amount,
      ),
      maxPerTransaction: normaliseHyperCardAmount(
        row.max_single_recharge_amount,
      ),
      maxPerDay: normaliseHyperCardAmount(row.max_recharge_amount),
      requiresInitialDeposit: isAffirmativeFlag(row.need_first_recharge),
      minInitialDeposit: normaliseHyperCardAmount(
        row.min_first_recharge_amount,
      ),
    },
    applicationMode,
    // Derived rather than read: their response has no KYC flag, and the domain
    // model requires the two to agree. Express is the only mode whose request
    // carries no KYC container at all.
    requiresKyc: applicationMode !== CardProductApplicationMode.NO_KYC,
    activation,
    sensitiveDetailMode: resolveSensitiveDetailMode(row),
    // `can_recharge` is not a funding detail here. Their page: when recharge is
    // unsupported "the card cannot be recharged and card opening application is
    // not allowed" — so a product that cannot be funded cannot be applied for,
    // and offering it would produce an application they reject.
    availableForIssuance:
      isEnabledFlag(row.status) && isEnabledFlag(row.can_recharge),
    supportedOperations: mapSupportedOperations(row),
  };
};

/**
 * Their whole catalogue, each product paired with the row it came from, and
 * unreadable rows dropped and counted.
 */
export const mapHyperCardCardProducts = (
  data: unknown,
): CardProductListing[] => {
  // `data` is unknown rather than an array: the transport's type argument is a
  // caller's expectation and nothing validates the payload against it, so a
  // non-array would be an untyped `is not iterable` crash rather than a
  // mapping failure.
  if (!Array.isArray(data)) {
    if (data !== null && data !== undefined) {
      logger.warn(
        `HyperCard card config list returned a ${typeof data} where their page documents an array — treating it as an empty catalogue.`,
      );
    }
    return [];
  }

  const rows = data as readonly HyperCardCardProductRow[];
  const listings: CardProductListing[] = [];
  const seenProductIds = new Set<string>();

  for (const row of rows) {
    const product = mapHyperCardCardProduct(row);
    if (product === null) continue;

    // A repeated handle would upsert onto the same natural key, so the later
    // row would silently overwrite the earlier one and a partner would see
    // whichever happened to come last. Dropping the duplicate and saying so
    // beats picking one without a reason.
    if (seenProductIds.has(product.providerProductId)) {
      exclude(row, 'another row in the same response already carries its id');
      continue;
    }
    seenProductIds.add(product.providerProductId);

    listings.push({
      product,
      // A deep copy, not a spread: their rows nest, and a shallow copy would
      // leave nested values aliased to the parsed response. This payload is
      // persisted and replayed, so it has to be a snapshot rather than a view.
      rawPayload: JSON.parse(JSON.stringify(row)) as Record<string, unknown>,
    });
  }

  const excluded = rows.length - listings.length;
  if (excluded > 0) {
    logger.warn(
      `Excluded ${excluded} of ${rows.length} HyperCard card products from the catalogue — see the warnings above.`,
    );
  }

  return listings;
};
