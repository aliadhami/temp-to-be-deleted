import { SelectQueryBuilder } from 'typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';
import { applyEnrolmentFilter } from './cardholder-enrolment-filter';

describe('applyEnrolmentFilter', () => {
  const query = () => {
    const andWhere = jest.fn();
    const builder = {
      andWhere,
    } as unknown as SelectQueryBuilder<CardholderEntity>;
    andWhere.mockReturnValue(builder);
    return { builder, andWhere };
  };

  const clauseOf = (andWhere: jest.Mock): string =>
    (andWhere.mock.calls[0] as [string])[0];

  it('adds no clause when nothing was asked for', () => {
    const { builder, andWhere } = query();

    applyEnrolmentFilter(builder, 'cardholder', {});

    expect(andWhere).not.toHaveBeenCalled();
  });

  it('correlates the subquery to the cardholder being listed', () => {
    const { builder, andWhere } = query();

    applyEnrolmentFilter(builder, 'cardholder', {
      providerKey: CardProviderKey.AXYS,
    });

    expect(clauseOf(andWhere)).toContain(
      'enrolment.cardholder_id = cardholder.id',
    );
  });

  it('puts both predicates in one subquery', () => {
    // A person pending at one issuer and approved at another must not match
    // provider+status on the strength of two different rows, which is exactly
    // what two separate EXISTS clauses would do.
    const { builder, andWhere } = query();

    applyEnrolmentFilter(builder, 'cardholder', {
      providerKey: CardProviderKey.AXYS,
      status: CardholderStatus.APPROVED,
    });

    expect(andWhere).toHaveBeenCalledTimes(1);
    const clause = clauseOf(andWhere);
    expect(clause).toContain('enrolment.provider_key = :enrolmentProviderKey');
    expect(clause).toContain('enrolment.status = :enrolmentStatus');
    expect(andWhere).toHaveBeenCalledWith(expect.any(String), {
      enrolmentProviderKey: CardProviderKey.AXYS,
      enrolmentStatus: CardholderStatus.APPROVED,
    });
  });

  it('binds only the predicate it was given', () => {
    const { builder, andWhere } = query();

    applyEnrolmentFilter(builder, 'cardholder', {
      status: CardholderStatus.PENDING,
    });

    expect(clauseOf(andWhere)).not.toContain('provider_key');
    expect(andWhere).toHaveBeenCalledWith(expect.any(String), {
      enrolmentStatus: CardholderStatus.PENDING,
    });
  });

  it('correlates against the alias it is given', () => {
    const { builder, andWhere } = query();

    applyEnrolmentFilter(builder, 'holder', {
      status: CardholderStatus.PENDING,
    });

    expect(clauseOf(andWhere)).toContain('enrolment.cardholder_id = holder.id');
  });
});
