import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records how a card issued against a catalogue product yields its number,
 * security code and expiry.
 */
export class AddCardProductSensitiveDetailMode1787007174504
  implements MigrationInterface
{
  name = 'AddCardProductSensitiveDetailMode1787007174504';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card_product\` ADD \`sensitive_detail_mode\` varchar(24) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card_product\` DROP COLUMN \`sensitive_detail_mode\``,
    );
  }
}
