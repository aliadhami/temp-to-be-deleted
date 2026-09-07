import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records when an issuer was last asked about a card's status, and indexes the
 * ordering that reads it. The column exists so a bounded sweep can take its
 * work least-recently-checked-first.
 */
export class AddCardStatusCheckedAt1786991851203 implements MigrationInterface {
  name = 'AddCardStatusCheckedAt1786991851203';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card\` ADD \`status_checked_at\` datetime(6) NULL`,
    );
    await queryRunner.query(`DROP INDEX \`idx_card_status\` ON \`card\``);
    await queryRunner.query(
      `CREATE INDEX \`idx_card_status_checked\` ON \`card\` (\`status\`, \`status_checked_at\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX \`idx_card_status_checked\` ON \`card\``,
    );
    await queryRunner.query(
      `CREATE INDEX \`idx_card_status\` ON \`card\` (\`status\`)`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card\` DROP COLUMN \`status_checked_at\``,
    );
  }
}
