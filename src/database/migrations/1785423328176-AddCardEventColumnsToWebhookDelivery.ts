import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCardEventColumnsToWebhookDelivery1785423328176
  implements MigrationInterface
{
  name = 'AddCardEventColumnsToWebhookDelivery1785423328176';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`webhook_delivery\` ADD \`cardholder_id\` bigint UNSIGNED NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`webhook_delivery\` ADD \`card_id\` bigint UNSIGNED NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`webhook_delivery\` DROP COLUMN \`card_id\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`webhook_delivery\` DROP COLUMN \`cardholder_id\``,
    );
  }
}
