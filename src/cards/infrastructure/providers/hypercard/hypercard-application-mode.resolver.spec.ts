import { CardProductApplicationMode } from '../../../domain/card-product-application-mode.enum';
import { CardProviderUnsupportedApplicationModeError } from '../../../domain/card-provider-unsupported-application-mode.error';
import { resolveHyperCardApplicationPath } from './hypercard-application-mode.resolver';

/**
 * The path from their "Application (Express)-v4" page, written out rather than
 * imported from the module under test: a spec asserting a constant against
 * itself passes however that constant is edited, and this is the one value in
 * the mapping that a typo makes unreachable rather than merely wrong.
 */
const EXPRESS_APPLICATION_PATH = '/v4/openapi/card/apply/quick';

/** Every mode this integration refuses, named so a failure reads as itself. */
const REFUSED_MODES = [
  CardProductApplicationMode.FULL_KYC,
  CardProductApplicationMode.PREISSUED_CARD,
  CardProductApplicationMode.KYC_WITH_BILLING_ADDRESS,
  CardProductApplicationMode.ONLINE_KYC,
] as const;

const refusalFor = (
  mode: string,
): CardProviderUnsupportedApplicationModeError => {
  try {
    resolveHyperCardApplicationPath(mode as CardProductApplicationMode);
  } catch (error) {
    return error as CardProviderUnsupportedApplicationModeError;
  }

  throw new Error(`Expected "${mode}" to be refused, and it resolved.`);
};

describe('resolveHyperCardApplicationPath', () => {
  it('sends the express mode to their express application endpoint', () => {
    expect(
      resolveHyperCardApplicationPath(CardProductApplicationMode.NO_KYC),
    ).toBe(EXPRESS_APPLICATION_PATH);
  });

  it.each(REFUSED_MODES)('refuses the %s mode', (mode) => {
    expect(() => resolveHyperCardApplicationPath(mode)).toThrow(
      CardProviderUnsupportedApplicationModeError,
    );
  });

  it.each(REFUSED_MODES)('carries the %s mode on the refusal', (mode) => {
    // Read off the error rather than out of the message: this is the half a
    // use-case reads when it composes what a partner sees, and the adapter
    // deliberately names no request field of its own.
    expect(refusalFor(mode).applicationMode).toBe(mode);
  });

  it('carries the modes it does serve, so a caller can name one', () => {
    // Derived from the mapping rather than listed twice, so widening the table
    // cannot leave this pointing at a mode that is still refused.
    expect(
      refusalFor(CardProductApplicationMode.FULL_KYC).supportedApplicationModes,
    ).toEqual([CardProductApplicationMode.NO_KYC]);
  });

  it.each(Object.values(CardProductApplicationMode))(
    'either resolves or refuses %s, never both and never silently',
    (mode) => {
      // Driven off the enum itself, so a member added to it is covered here
      // without this spec being edited — the case that would otherwise slip
      // through is a new mode falling into a default and being applied for down
      // a path chosen for a different one.
      let resolved: string | undefined;
      let caught: unknown;
      try {
        resolved = resolveHyperCardApplicationPath(mode);
      } catch (error) {
        caught = error;
      }

      if (mode === CardProductApplicationMode.NO_KYC) {
        expect(resolved).toBe(EXPRESS_APPLICATION_PATH);
        expect(caught).toBeUndefined();
      } else {
        expect(resolved).toBeUndefined();
        expect(caught).toBeInstanceOf(
          CardProviderUnsupportedApplicationModeError,
        );
      }
    },
  );

  it.each([
    ['a mode from a build this one does not know', 'DOCUMENTS_BY_POST'],
    ['an empty value', ''],
    ['their own vocabulary', '2'],
  ])('refuses %s the same way', (_case, value) => {
    // Not merely defensive: the mode reaches this function from a stored
    // catalogue row whose column is a `varchar`, so a row written by an older
    // or newer build carries that build's enum.
    expect(() =>
      resolveHyperCardApplicationPath(value as CardProductApplicationMode),
    ).toThrow(CardProviderUnsupportedApplicationModeError);
  });

  it.each([
    ['toString'],
    ['constructor'],
    ['valueOf'],
    ['hasOwnProperty'],
    ['__proto__'],
  ])('refuses the inherited property name %s', (value) => {
    // A plain object lookup reads through `Object.prototype`, so each of these
    // returns an inherited function or object rather than undefined — none of
    // which is null, so a null-only guard passes it straight through and the
    // caller sends `function toString() { [native code] }` as a URL path.
    expect(() =>
      resolveHyperCardApplicationPath(value as CardProductApplicationMode),
    ).toThrow(CardProviderUnsupportedApplicationModeError);
  });
});
