import { SelectQueryBuilder } from 'typeorm';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';

export interface CardholderEnrolmentFilter {
  status?: CardholderStatus;
  providerKey?: CardProviderKey;
}

/**
 * Narrows a cardholder query to people holding an enrolment that satisfies
 * **every** supplied predicate at once. One subquery, not one per predicate:
 * a person pending at one issuer and approved at another must not match
 * `providerKey=X&status=APPROVED` on the strength of two different rows.
 *
 * Filters stored rows and nothing else, so a person stays listable after the
 * issuer they were enrolled with is switched off in this deployment.
 */
export const applyEnrolmentFilter = (
  query: SelectQueryBuilder<CardholderEntity>,
  alias: string,
  filter: CardholderEnrolmentFilter,
): SelectQueryBuilder<CardholderEntity> => {
  const predicates = [`enrolment.cardholder_id = ${alias}.id`];

  if (filter.providerKey) {
    predicates.push('enrolment.provider_key = :enrolmentProviderKey');
  }
  if (filter.status) {
    predicates.push('enrolment.status = :enrolmentStatus');
  }
  if (predicates.length === 1) return query;

  return query.andWhere(
    `EXISTS (SELECT 1 FROM cardholder_enrolment enrolment WHERE ${predicates.join(' AND ')})`,
    {
      ...(filter.providerKey && { enrolmentProviderKey: filter.providerKey }),
      ...(filter.status && { enrolmentStatus: filter.status }),
    },
  );
};
