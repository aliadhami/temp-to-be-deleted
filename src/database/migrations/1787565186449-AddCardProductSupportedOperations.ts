import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records which operations an issuer offers against a card issued against a
 * catalogue product.
 */
export class AddCardProductSupportedOperations1787565186449
  implements MigrationInterface
{
  name = 'AddCardProductSupportedOperations1787565186449';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Nullable, backfilled, then tightened: a `json NOT NULL` column added in
    // one statement fills existing rows with a value `json_valid` rejects.
    await queryRunner.query(
      `ALTER TABLE \`card_product\` ADD \`supported_operations\` json NULL`,
    );
    await queryRunner.query(backfillFromRawPayload());
    await queryRunner.query(
      `ALTER TABLE \`card_product\` MODIFY \`supported_operations\` json NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card_product\` DROP COLUMN \`supported_operations\``,
    );
  }
}

/**
 * One issuer's operation codes and what this codebase calls them. Duplicated
 * from the adapter rather than imported: a migration is a record of what ran,
 * and an import would let a later edit rewrite history.
 */
const OPERATIONS: ReadonlyArray<readonly [code: string, operation: string]> = [
  ['1', 'BLOCK'],
  ['2', 'UNBLOCK'],
  ['3', 'REPORT_LOSS'],
  ['4', 'RESET_PASSWORD'],
  ['5', 'REISSUE'],
  ['6', 'CHANGE_PIN'],
  ['9', 'CANCEL'],
];

/**
 * Rebuilds the list from the stored provider payload, so a row written before
 * this column existed does not publish "the issuer offers no operations" until
 * the next catalogue sync corrects it.
 *
 * Members come out in this table's order rather than the issuer's, unlike the
 * adapter's; the two are sets, and the next sync rewrites the row anyway. A
 * code the issuer publishes and this codebase cannot name is dropped, matching
 * the adapter. A provider that publishes no such field yields `[]`.
 */
const backfillFromRawPayload = (): string => {
  // Their field is a comma-separated list of integers, which is exactly what
  // FIND_IN_SET reads. `JSON_UNQUOTE(JSON_EXTRACT(…))` rather than
  // `JSON_VALUE`, which older servers do not have.
  const codes = `REPLACE(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(\`raw_payload\`, '$.support_business')), ''), ' ', '')`;

  const members = OPERATIONS.map(
    ([code, operation]) =>
      `CASE WHEN FIND_IN_SET('${code}', ${codes}) THEN '"${operation}"' END`,
  ).join(', ');

  // CONCAT_WS skips its NULL arguments, so an unmatched code contributes
  // nothing and no separator.
  return (
    `UPDATE \`card_product\` ` +
    `SET \`supported_operations\` = CONCAT('[', CONCAT_WS(',', ${members}), ']') ` +
    `WHERE \`supported_operations\` IS NULL`
  );
};
