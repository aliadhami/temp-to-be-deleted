import { MigrationInterface, QueryRunner } from 'typeorm';

export class SeedRoles1784016079458 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO \`role\` (\`key\`, \`name\`) VALUES
      ('ADMIN', 'Administrator'),
      ('FINANCE', 'Finance'),
      ('OPERATOR', 'Operator'),
      ('APPROVER', 'Approver'),
      ('AUDITOR', 'Auditor'),
      ('PARTNER', 'Partner')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM \`role\` WHERE \`key\` IN
      ('ADMIN','FINANCE','OPERATOR','APPROVER','AUDITOR','PARTNER')`,
    );
  }
}
