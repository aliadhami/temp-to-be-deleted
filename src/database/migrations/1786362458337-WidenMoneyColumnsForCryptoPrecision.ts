import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Money columns were decimal(18,2) — two decimal places, which is correct for
 * USD/AED/EUR but wrong for three separate reasons:
 *
 *   - Crypto needs far more: BTC has 8 decimals (1 satoshi = 0.00000001),
 *     ETH and most ERC20 tokens have 18 (1 wei = 1e-18).
 *   - Several currencies in our own region have 3, not 2: KWD, BHD, OMR, JOD
 *     (also IQD, LYD, TND). At scale 2, 15.750 KWD silently became 15.75.
 *   - JPY has 0. Scale 2 is not a universal truth about money.
 *
 * decimal(38,18) = 20 integer digits + 18 decimals. Exact (never float), and
 * `mysql2` returns DECIMAL as a string, so the existing "money is a string
 * end-to-end" rule keeps holding with no conversion layer.
 *
 * WHY NOT bigint minor units (the ERC20 shape): BIGINT UNSIGNED maxes at
 * 18,446,744,073,709,551,615 — at 18 decimals that is **18.4 ETH in total**.
 * ERC20 gets away with it because Solidity has uint256 (78 digits); MariaDB has
 * no equivalent integer type. A units+exponent pair would also break every SQL
 * SUM (you cannot add two rows with different exponents) and introduces a
 * silent order-of-magnitude corruption whenever the exponent is wrong.
 *
 * This is a WIDENING change: every existing value is preserved exactly, and
 * "10.00" simply reads back as "10.000000000000000000". Nothing to backfill.
 *
 * `partner.fee_percent` stays decimal(6,3) — it is a rate, not an amount.
 */
export class WidenMoneyColumnsForCryptoPrecision1786362458337 implements MigrationInterface {
  name = 'WidenMoneyColumnsForCryptoPrecision1786362458337';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` MODIFY COLUMN \`amount\` decimal(38,18) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` MODIFY COLUMN \`refunded_amount\` decimal(38,18) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payout\` MODIFY COLUMN \`amount\` decimal(38,18) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payout\` MODIFY COLUMN \`fee\` decimal(38,18) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`refund\` MODIFY COLUMN \`amount\` decimal(38,18) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`fee_record\` MODIFY COLUMN \`gateway_fee\` decimal(38,18) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`fee_record\` MODIFY COLUMN \`partner_fee\` decimal(38,18) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`partner\` MODIFY COLUMN \`fee_flat\` decimal(38,18) NULL`,
    );
  }

  /**
   * Reverting ROUNDS every value to 2 decimal places and will fail outright on
   * any amount whose integer part exceeds 16 digits. If crypto transactions
   * exist this destroys data — check first:
   *   SELECT id, amount FROM payment_transaction WHERE amount <> ROUND(amount, 2);
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`partner\` MODIFY COLUMN \`fee_flat\` decimal(18,2) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`fee_record\` MODIFY COLUMN \`partner_fee\` decimal(18,2) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`fee_record\` MODIFY COLUMN \`gateway_fee\` decimal(18,2) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`refund\` MODIFY COLUMN \`amount\` decimal(18,2) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payout\` MODIFY COLUMN \`fee\` decimal(18,2) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payout\` MODIFY COLUMN \`amount\` decimal(18,2) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` MODIFY COLUMN \`refunded_amount\` decimal(18,2) NOT NULL DEFAULT '0.00'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`payment_transaction\` MODIFY COLUMN \`amount\` decimal(18,2) NOT NULL`,
    );
  }
}
