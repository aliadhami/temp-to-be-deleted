import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One row per attempt to put money on an already-issued card, written before
 * the issuer is called.
 */
export class CreateCardDepositTable1787056645801 implements MigrationInterface {
  name = 'CreateCardDepositTable1787056645801';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`card_deposit\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`card_id\` bigint UNSIGNED NOT NULL, \`provider_key\` varchar(20) NOT NULL, \`request_id\` varchar(64) COLLATE "utf8mb4_nopad_bin" NOT NULL, \`provider_reference\` varchar(80) NOT NULL, \`provider_deposit_id\` varchar(64) NULL, \`amount\` varchar(32) NOT NULL, \`currency_code\` varchar(16) NOT NULL, \`credited_amount\` varchar(32) NULL, \`status\` varchar(24) NOT NULL DEFAULT 'DRAFT', \`reason_code\` varchar(40) NULL, \`message\` varchar(255) NULL, \`response_payload\` json NULL, \`status_checked_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_card_deposit_card_created\` (\`card_id\`, \`created_at\`), INDEX \`idx_card_deposit_status_checked\` (\`status\`, \`status_checked_at\`), UNIQUE INDEX \`uq_card_deposit_provider_request\` (\`provider_key\`, \`request_id\`), UNIQUE INDEX \`IDX_959128316c996fb3c957bef6ef\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`card_deposit\` ADD CONSTRAINT \`FK_3177eef5ec3c9a0df1cff214664\` FOREIGN KEY (\`card_id\`) REFERENCES \`card\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`card_deposit\` DROP FOREIGN KEY \`FK_3177eef5ec3c9a0df1cff214664\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_959128316c996fb3c957bef6ef\` ON \`card_deposit\``,
    );
    await queryRunner.query(
      `DROP INDEX \`uq_card_deposit_provider_request\` ON \`card_deposit\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_card_deposit_status_checked\` ON \`card_deposit\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_card_deposit_card_created\` ON \`card_deposit\``,
    );
    await queryRunner.query(`DROP TABLE \`card_deposit\``);
  }
}
