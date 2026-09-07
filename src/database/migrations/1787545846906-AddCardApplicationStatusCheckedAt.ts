import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records when an issuer was last asked what became of an application, and
 * indexes the ordering that reads it. Without it the result sweep can only
 * order by id, so an application that never resolves holds the head of the
 * queue for ever and newer ones are never examined.
 */
export class AddCardApplicationStatusCheckedAt1787545846906
  implements MigrationInterface
{
  name = 'AddCardApplicationStatusCheckedAt1787545846906';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card_application\` ADD \`status_checked_at\` datetime(6) NULL`,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_card_application_status\` ON \`card_application\``,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_card_application_status_checked\` ON \`card_application\` (\`status\`, \`status_checked_at\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`idx_card_application_status_checked\` ON \`card_application\``,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_card_application_status\` ON \`card_application\` (\`status\`)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card_application\` DROP COLUMN \`status_checked_at\``,
    );
  }
}
