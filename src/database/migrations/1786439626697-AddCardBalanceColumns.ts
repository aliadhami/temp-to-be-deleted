import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCardBalanceColumns1786439626697 implements MigrationInterface {
  name = 'AddCardBalanceColumns1786439626697';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`card\`
        ADD COLUMN \`balance_available\` VARCHAR(32) NULL,
        ADD COLUMN \`balance_ledger\` VARCHAR(32) NULL,
        ADD COLUMN \`balance_currency\` VARCHAR(3) NULL,
        ADD COLUMN \`balance_observed_at\` DATETIME(6) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`card\`
        DROP COLUMN \`balance_available\`,
        DROP COLUMN \`balance_ledger\`,
        DROP COLUMN \`balance_currency\`,
        DROP COLUMN \`balance_observed_at\`
    `);
  }
}
