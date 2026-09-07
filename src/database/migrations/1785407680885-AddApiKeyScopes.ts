import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddApiKeyScopes1785407680885 implements MigrationInterface {
  name = 'AddApiKeyScopes1785407680885';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`partner_api_key\` ADD \`scopes\` json NOT NULL DEFAULT ('["PAYMENTS","CARDS"]')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`partner_api_key\` DROP COLUMN \`scopes\``,
    );
  }
}
