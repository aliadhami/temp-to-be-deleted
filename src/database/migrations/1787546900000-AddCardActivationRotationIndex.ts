import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes the query that takes cards with an activation outstanding ahead of
 * the rotation. Without it that query can only range-scan every card at
 * `NOT_ACTIVATED` in stamp order and filter as it walks — and since a pending
 * activation clears within minutes while a card nobody ever activates stays
 * selectable for the life of the account, the rows it wants are a vanishing
 * fraction of the rows it would have to read.
 *
 * `idx_card_status_checked` is left in place: it serves the rotation query,
 * which does not constrain `activation_status` at all.
 */
export class AddCardActivationRotationIndex1787546900000
  implements MigrationInterface
{
  name = 'AddCardActivationRotationIndex1787546900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX \`idx_card_activation_checked\` ON \`card\` (\`status\`, \`activation_status\`, \`status_checked_at\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`idx_card_activation_checked\` ON \`card\``,
    );
  }
}
