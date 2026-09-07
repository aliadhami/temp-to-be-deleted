import { Logger } from '@nestjs/common';
import { mapHyperCardOperationStatus } from './hypercard-operation-status.mapper';

describe('mapHyperCardOperationStatus', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Their "Card Operation result" statuses, all five, with what each means in
  // their own words.
  it.each([
    [0, 'PENDING', 'In operation'],
    [1, 'APPLIED', 'Third party success'],
    [2, 'FAILED', 'Fail'],
    [98, 'PENDING', 'Pending payment'],
    [99, 'PENDING', 'Waiting for third party'],
  ])('maps their code %i to %s (%s)', (code, expected) => {
    expect(mapHyperCardOperationStatus(code)).toBe(expected);
  });

  it.each([
    ['0', 'PENDING'],
    ['1', 'APPLIED'],
    ['2', 'FAILED'],
    ['98', 'PENDING'],
    ['99', 'PENDING'],
  ])('reads their code "%s" in string form too', (code, expected) => {
    // Both forms: an integer on their result query and a string on their push
    // event, for the same five values.
    expect(mapHyperCardOperationStatus(code)).toBe(expected);
  });

  it('treats their failure as terminal, which is an inference', () => {
    // The one mapping here resting on an absence: their recharge appendix marks
    // finality explicitly and this list does not.
    expect(mapHyperCardOperationStatus(2)).toBe('FAILED');
  });

  it('keeps their awaiting-payment status pending and says so distinctly', () => {
    // Pending for the write, since waiting is the recoverable direction — but
    // not in the log, a freeze costing nothing.
    expect(mapHyperCardOperationStatus(98)).toBe('PENDING');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('payment'));
  });

  it.each([
    ['a code they have not documented', 3],
    ['a code they have not documented, as a string', '3'],
    ['their empty value', ''],
    ['whitespace', '   '],
    ['a decimal', '1.5'],
    ['absent', undefined],
    ['null', null],
    ['an object', { operate_status: 1 }],
  ])('returns null for %s', (_label, raw) => {
    expect(mapHyperCardOperationStatus(raw)).toBeNull();
  });

  it('warns rather than throwing on a code it does not recognise', () => {
    // Warned so one unfamiliar code cannot take down a pass examining a batch,
    // the operation being left alone rather than guessed into a terminal state.
    expect(() => mapHyperCardOperationStatus(7)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('7'));
  });

  it('does not warn on a code it recognises', () => {
    mapHyperCardOperationStatus(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
