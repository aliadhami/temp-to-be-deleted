import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentLedger1784014602429 implements MigrationInterface {
  name = 'CreatePaymentLedger1784014602429';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`payment_transaction\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`partner_id\` bigint UNSIGNED NULL, \`gateway_key\` varchar(20) NOT NULL, \`request_id\` varchar(64) NOT NULL, \`reference_number\` varchar(64) NOT NULL, \`method\` varchar(20) NOT NULL, \`amount\` decimal(18,2) NOT NULL, \`currency\` varchar(3) NOT NULL, \`status\` varchar(24) NOT NULL DEFAULT 'PENDING', \`refunded_amount\` decimal(18,2) NOT NULL DEFAULT '0.00', \`reason_code\` varchar(20) NULL, \`message\` varchar(255) NULL, \`provider_ref\` varchar(80) NULL, \`customer_email\` varchar(255) NULL, \`customer_name\` varchar(150) NULL, \`customer_country\` char(2) NULL, \`callback_url\` varchar(500) NULL, \`request_payload\` json NULL, \`response_payload\` json NULL, \`initiated_at\` datetime(6) NOT NULL, \`completed_at\` datetime(6) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_txn_created_at\` (\`created_at\`), INDEX \`idx_txn_provider_ref\` (\`provider_ref\`), INDEX \`idx_txn_reference\` (\`reference_number\`), INDEX \`idx_txn_partner\` (\`partner_id\`), INDEX \`idx_txn_status\` (\`status\`), UNIQUE INDEX \`uq_txn_gateway_request\` (\`gateway_key\`, \`request_id\`), UNIQUE INDEX \`IDX_65eac6b207033a6d1f32b32342\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`transaction_event\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`transaction_id\` bigint UNSIGNED NOT NULL, \`from_status\` varchar(24) NULL, \`to_status\` varchar(24) NOT NULL, \`source\` varchar(20) NOT NULL, \`detail\` varchar(255) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX \`idx_event_txn_created\` (\`transaction_id\`, \`created_at\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`transaction_event\` ADD CONSTRAINT \`FK_fc11219d0b59f2c93e7c40f0126\` FOREIGN KEY (\`transaction_id\`) REFERENCES \`payment_transaction\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`transaction_event\` DROP FOREIGN KEY \`FK_fc11219d0b59f2c93e7c40f0126\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_event_txn_created\` ON \`transaction_event\``,
    );
    await queryRunner.query(`DROP TABLE \`transaction_event\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_65eac6b207033a6d1f32b32342\` ON \`payment_transaction\``,
    );
    await queryRunner.query(
      `DROP INDEX \`uq_txn_gateway_request\` ON \`payment_transaction\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_txn_status\` ON \`payment_transaction\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_txn_partner\` ON \`payment_transaction\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_txn_reference\` ON \`payment_transaction\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_txn_provider_ref\` ON \`payment_transaction\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_txn_created_at\` ON \`payment_transaction\``,
    );
    await queryRunner.query(`DROP TABLE \`payment_transaction\``);
  }
}
