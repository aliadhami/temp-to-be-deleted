import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaymentTransactionEntity } from '../infrastructure/persistence/payment-transaction.entity';

export interface AnalyticsFilters {
  partnerId?: string;
  gatewayKey?: string;
  startDate?: string;
  endDate?: string;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(PaymentTransactionEntity)
    private readonly transactionRepository: Repository<PaymentTransactionEntity>,
  ) {}

  async getDashboardMetrics(filters: AnalyticsFilters) {
    const qb = this.transactionRepository.createQueryBuilder('txn');

    // Dynamically apply read-only filters
    if (filters.partnerId) {
      qb.andWhere('txn.partnerId = :partnerId', {
        partnerId: filters.partnerId,
      });
    }
    if (filters.gatewayKey) {
      qb.andWhere('txn.gatewayKey = :gatewayKey', {
        gatewayKey: filters.gatewayKey,
      });
    }
    if (filters.startDate) {
      qb.andWhere('txn.createdAt >= :startDate', {
        startDate: filters.startDate,
      });
    }
    if (filters.endDate) {
      qb.andWhere('txn.createdAt <= :endDate', { endDate: filters.endDate });
    }

    // 1. Core KPIs (Gross Volume, Count, Success Rate)
    // CAST keeps the database returning an exact string rather than a float.
    // The scale MUST match the amount column's (38,18): casting a crypto sum
    // down to (18,2) would round 0.00000001 BTC of volume to 0.00 and report
    // zero. Callers format for display; this value stays exact.
    //
    // NOTE (pre-existing, unrelated to precision): this sums across every
    // currency in scope, so a mixed AED + USDT result is not a meaningful
    // total. Grouping by currency is a separate fix.
    const kpiRaw = await qb
      .clone()
      .select([
        `CAST(COALESCE(SUM(CASE WHEN txn.status = 'PAID' THEN txn.amount ELSE 0 END), 0) AS DECIMAL(38,18)) as grossVolume`,
        `COUNT(txn.id) as totalTransactions`,
        `COUNT(CASE WHEN txn.status = 'PAID' THEN 1 END) as successfulTransactions`,
        `COUNT(CASE WHEN txn.status IN ('PAID', 'FAILED', 'REJECTED', 'ERROR') THEN 1 END) as terminalTransactions`,
      ])
      .getRawOne();

    // Safely assign without using parseFloat to avoid Javascript precision loss.
    // Fallback matches the column's scale so the shape is consistent whether or
    // not any rows matched.
    const grossVolume = kpiRaw.grossVolume || '0.000000000000000000';
    const totalTransactions = parseInt(kpiRaw.totalTransactions || '0', 10);
    const successfulTransactions = parseInt(
      kpiRaw.successfulTransactions || '0',
      10,
    );
    const terminalTransactions = parseInt(
      kpiRaw.terminalTransactions || '0',
      10,
    );

    const successRate =
      terminalTransactions > 0
        ? ((successfulTransactions / terminalTransactions) * 100).toFixed(2)
        : '0.00';

    // 2. Breakdowns (For Pie & Bar Charts)
    const byGateway = await qb
      .clone()
      .select('txn.gatewayKey', 'gateway')
      .addSelect('COUNT(txn.id)', 'count')
      .groupBy('txn.gatewayKey')
      .getRawMany();

    const byMethod = await qb
      .clone()
      .select('txn.method', 'method')
      .addSelect('COUNT(txn.id)', 'count')
      .groupBy('txn.method')
      .getRawMany();

    const byCurrency = await qb
      .clone()
      .select('txn.currency', 'currency')
      .addSelect('COUNT(txn.id)', 'count')
      .groupBy('txn.currency')
      .getRawMany();

    // 3. Failure Analytics (Reason Codes)
    const failureReasons = await qb
      .clone()
      .select('COALESCE(txn.reasonCode, "UNKNOWN")', 'reasonCode')
      .addSelect('COUNT(txn.id)', 'count')
      .andWhere("txn.status IN ('FAILED', 'REJECTED', 'ERROR')")
      .groupBy('COALESCE(txn.reasonCode, "UNKNOWN")')
      .getRawMany();

    return {
      kpis: {
        grossVolume,
        totalTransactions,
        successfulTransactions,
        successRate,
      },
      breakdowns: {
        byGateway: byGateway.map((row) => ({
          name: row.gateway,
          value: parseInt(row.count, 10),
        })),
        byMethod: byMethod.map((row) => ({
          name: row.method,
          value: parseInt(row.count, 10),
        })),
        byCurrency: byCurrency.map((row) => ({
          name: row.currency,
          value: parseInt(row.count, 10),
        })),
        failureReasons: failureReasons.map((row) => ({
          name: row.reasonCode,
          value: parseInt(row.count, 10),
        })),
      },
    };
  }
}
