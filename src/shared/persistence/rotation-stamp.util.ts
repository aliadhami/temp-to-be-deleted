import { ObjectLiteral, Repository } from 'typeorm';

/**
 * Records that a bounded sweep looked at these rows, for every table whose
 * batch rotates on `status_checked_at`.
 *
 * Raw SQL because TypeORM writes `@UpdateDateColumn` into every `SET` clause it
 * builds, and `updated_at` is assigned to itself because the column is
 * `ON UPDATE CURRENT_TIMESTAMP(6)` and fires whatever the `SET` list names.
 * Being asked is not a change.
 *
 * `table` must be a source literal — a table name cannot be a bound parameter.
 */
export const stampCheckedAt = async (
  repository: Repository<ObjectLiteral>,
  table: string,
  ids: readonly string[],
): Promise<void> => {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(', ');

  await repository.query(
    `UPDATE \`${table}\` SET \`status_checked_at\` = ?, \`updated_at\` = \`updated_at\` WHERE \`id\` IN (${placeholders})`,
    [new Date(), ...ids],
  );
};
