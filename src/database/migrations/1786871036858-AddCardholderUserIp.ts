import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the end user's IP to `cardholder`. `varchar(45)` is the longest an IPv6
 * address can be written, including the IPv4-mapped form.
 */
export class AddCardholderUserIp1786871036858 implements MigrationInterface {
  name = 'AddCardholderUserIp1786871036858';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`cardholder\`
        ADD COLUMN \`user_ip\` VARCHAR(45) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`cardholder\`
        DROP COLUMN \`user_ip\`
    `);
  }
}
