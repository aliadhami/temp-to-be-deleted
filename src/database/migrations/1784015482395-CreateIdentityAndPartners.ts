import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdentityAndPartners1784015482395
  implements MigrationInterface
{
  name = 'CreateIdentityAndPartners1784015482395';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`role\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`key\` varchar(40) NOT NULL, \`name\` varchar(80) NOT NULL, UNIQUE INDEX \`IDX_128d7c8c9af53479d0b9e00eb5\` (\`key\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`partner\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`name\` varchar(150) NOT NULL, \`status\` varchar(20) NOT NULL DEFAULT 'ACTIVE', \`allowed_gateways\` json NOT NULL, \`allowed_currencies\` json NOT NULL, \`allowed_methods\` json NOT NULL, \`fee_percent\` decimal(6,3) NULL, \`fee_flat\` decimal(18,2) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`IDX_1eb7fbdcb682fe58e5b9dd2dbc\` (\`public_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`user_account\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`public_id\` char(36) NOT NULL, \`email\` varchar(255) NOT NULL, \`password_hash\` varchar(255) NOT NULL, \`display_name\` varchar(150) NOT NULL, \`is_partner_user\` tinyint NOT NULL DEFAULT 0, \`partner_id\` bigint UNSIGNED NULL, \`status\` varchar(20) NOT NULL DEFAULT 'ACTIVE', \`mfa_enabled\` tinyint NOT NULL DEFAULT 0, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`idx_user_partner\` (\`partner_id\`), UNIQUE INDEX \`IDX_911f8651b8ce1b3f94f96f9968\` (\`public_id\`), UNIQUE INDEX \`IDX_56a0e4bcec2b5411beafa47ffa\` (\`email\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`partner_gateway_credential\` (\`id\` bigint UNSIGNED NOT NULL AUTO_INCREMENT, \`partner_id\` bigint UNSIGNED NOT NULL, \`gateway_key\` varchar(20) NOT NULL, \`credentials_encrypted\` blob NOT NULL, \`environment\` varchar(20) NOT NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), UNIQUE INDEX \`uq_partner_gateway_env\` (\`partner_id\`, \`gateway_key\`, \`environment\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`user_role\` (\`user_id\` bigint UNSIGNED NOT NULL, \`role_id\` bigint UNSIGNED NOT NULL, INDEX \`IDX_d0e5815877f7395a198a4cb0a4\` (\`user_id\`), INDEX \`IDX_32a6fc2fcb019d8e3a8ace0f55\` (\`role_id\`), PRIMARY KEY (\`user_id\`, \`role_id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_account\` ADD CONSTRAINT \`FK_8781959c39e9e25c8d420e81cf1\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`partner_gateway_credential\` ADD CONSTRAINT \`FK_a5d3fa7838dc8772dc9f56b770e\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` ADD CONSTRAINT \`FK_aab47e1e701fa64b94ebd1dc9ac\` FOREIGN KEY (\`partner_id\`) REFERENCES \`partner\`(\`id\`) ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_role\` ADD CONSTRAINT \`FK_d0e5815877f7395a198a4cb0a46\` FOREIGN KEY (\`user_id\`) REFERENCES \`user_account\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_role\` ADD CONSTRAINT \`FK_32a6fc2fcb019d8e3a8ace0f55f\` FOREIGN KEY (\`role_id\`) REFERENCES \`role\`(\`id\`) ON DELETE CASCADE ON UPDATE CASCADE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`user_role\` DROP FOREIGN KEY \`FK_32a6fc2fcb019d8e3a8ace0f55f\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_role\` DROP FOREIGN KEY \`FK_d0e5815877f7395a198a4cb0a46\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` DROP FOREIGN KEY \`FK_aab47e1e701fa64b94ebd1dc9ac\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`partner_gateway_credential\` DROP FOREIGN KEY \`FK_a5d3fa7838dc8772dc9f56b770e\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`user_account\` DROP FOREIGN KEY \`FK_8781959c39e9e25c8d420e81cf1\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_32a6fc2fcb019d8e3a8ace0f55\` ON \`user_role\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_d0e5815877f7395a198a4cb0a4\` ON \`user_role\``,
    );
    await queryRunner.query(`DROP TABLE \`user_role\``);
    await queryRunner.query(
      `DROP INDEX \`uq_partner_gateway_env\` ON \`partner_gateway_credential\``,
    );
    await queryRunner.query(`DROP TABLE \`partner_gateway_credential\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_56a0e4bcec2b5411beafa47ffa\` ON \`user_account\``,
    );
    await queryRunner.query(
      `DROP INDEX \`IDX_911f8651b8ce1b3f94f96f9968\` ON \`user_account\``,
    );
    await queryRunner.query(
      `DROP INDEX \`idx_user_partner\` ON \`user_account\``,
    );
    await queryRunner.query(`DROP TABLE \`user_account\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_1eb7fbdcb682fe58e5b9dd2dbc\` ON \`partner\``,
    );
    await queryRunner.query(`DROP TABLE \`partner\``);
    await queryRunner.query(
      `DROP INDEX \`IDX_128d7c8c9af53479d0b9e00eb5\` ON \`role\``,
    );
    await queryRunner.query(`DROP TABLE \`role\``);
  }
}
