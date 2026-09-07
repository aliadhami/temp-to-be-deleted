import { Logger } from '@nestjs/common';
import { mapHyperCardRechargeStatus } from './hypercard-recharge-status.mapper';

describe('mapHyperCardRechargeStatus', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Their "Recharge status" appendix, all five codes, with the final column
  // spelled out — it is what the mapping exists to preserve.
  it.each([
    [0, 'PENDING', 'pending, not final'],
    [1, 'SETTLED', 'SUCCESS, final'],
    [2, 'FAILED', 'FAIL, not final — it can still become a refund'],
    [3, 'REFUND_PENDING', 'TOBE REFUND, not final'],
    [4, 'REFUNDED', 'REFUNDED, final'],
  ])('maps their code %i to %s (%s)', (code, expected) => {
    expect(mapHyperCardRechargeStatus(code)).toBe(expected);
  });

  it.each([
    ['0', 'PENDING'],
    ['1', 'SETTLED'],
    ['2', 'FAILED'],
    ['3', 'REFUND_PENDING'],
    ['4', 'REFUNDED'],
  ])('reads their code "%s" in string form too', (code, expected) => {
    // Both forms, because their status codes arrive typed inconsistently across
    // their API — and their sandbox has contradicted both columns of their own
    // documentation before. The live recharge query returns this one as a
    // number while their own sample response quotes several of its siblings.
    expect(mapHyperCardRechargeStatus(code)).toBe(expected);
  });

  it('does not treat their failure status as final', () => {
    // The mistake this whole mapper exists to prevent, asserted as its own
    // case rather than left implicit in the table above: a settlement pass
    // that stopped asking here would never see the refund their appendix says
    // can follow, and would leave a partner told that money was lost which in
    // fact came back.
    expect(mapHyperCardRechargeStatus(2)).toBe('FAILED');
    expect(mapHyperCardRechargeStatus(2)).not.toBe('REFUNDED');
  });

  it.each([
    ['a code they have not documented', 9],
    ['a code they have not documented, as a string', '9'],
    ['their empty value', ''],
    ['whitespace', '   '],
    ['a decimal', '1.5'],
    ['absent', undefined],
    ['null', null],
    ['an object', { status: 1 }],
  ])('returns null for %s', (_label, raw) => {
    expect(mapHyperCardRechargeStatus(raw)).toBeNull();
  });

  it('warns rather than throwing on a code it does not recognise', () => {
    // Warned so one unfamiliar code cannot take down a pass examining a batch,
    // and so the row it describes is left to be asked about again rather than
    // guessed into a state nothing can correct.
    expect(() => mapHyperCardRechargeStatus(99)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    // The code they sent is in the line, so an operator can see which value
    // was not recognised rather than only that one was not.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('99'));
  });

  it('does not warn on a code it recognises', () => {
    mapHyperCardRechargeStatus(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
