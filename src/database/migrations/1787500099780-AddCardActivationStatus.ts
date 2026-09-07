import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records whether an activation attempt is outstanding on a card, and why the
 * last one was refused.
 *
 * `status` cannot carry this: a card whose activation an issuer has accepted
 * but not yet settled is still not activated, so the two states are
 * indistinguishable there — and widening `CardStatus` would change what
 * `NOT_ACTIVATED` returns to every partner already filtering on it.
 *
 * The reason widths match `card_application`'s, so a value cannot be
 * truncated differently in the two places it lands.
 */
export class AddCardActivationStatus1787500099780
  implements MigrationInterface
{
  name = 'AddCardActivationStatus1787500099780';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card\` ADD \`activation_status\` varchar(20) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` ADD \`activation_reason_code\` varchar(40) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` ADD \`activation_reason\` varchar(255) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card\` DROP COLUMN \`activation_reason\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` DROP COLUMN \`activation_reason_code\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` DROP COLUMN \`activation_status\``,
    );
  }
}
