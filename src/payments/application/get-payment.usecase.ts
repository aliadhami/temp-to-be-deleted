import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PartnerEntity } from '../../partners/persistence/partner.entity';
import { PaymentTransactionEntity } from '../infrastructure/persistence/payment-transaction.entity';

const buildCheckoutReturnUrl = (
  checkoutReturnUrl: string | null | undefined,
  publicId: string,
): string | null => {
  if (!checkoutReturnUrl) return null;
  try {
    const url = new URL(checkoutReturnUrl);
    url.searchParams.set('publicId', publicId);
    return url.toString();
  } catch {
    return null;
  }
};

@Injectable()
export class GetPaymentUseCase {
  constructor(
    @InjectRepository(PaymentTransactionEntity)
    private readonly transactionRepository: Repository<PaymentTransactionEntity>,
    @InjectRepository(PartnerEntity)
    private readonly partnerRepository: Repository<PartnerEntity>,
  ) {}

  /** Partner-scoped lookup — single transaction detail */
  async execute(partnerId: string, publicId: string) {
    const transaction = await this.transactionRepository.findOne({
      where: { publicId, partnerId },
    });
    if (!transaction) throw new NotFoundException('Payment not found');
    return this.toDetailResponse(transaction);
  }

  /** Staff/admin lookup — single transaction detail */
  async executeForStaff(publicId: string) {
    const transaction = await this.transactionRepository.findOne({
      where: { publicId },
    });
    if (!transaction) throw new NotFoundException('Payment not found');
    return this.toDetailResponse(transaction);
  }

  /** Staff/admin list — retrieves all transactions joined with partner details */
  async listForStaff() {
    const transactions = await this.transactionRepository.find({
      relations: { partner: true },
      order: { createdAt: 'DESC' },
      take: 100,
    });

    return transactions.map((t) => ({
      publicId: t.publicId,
      partnerPublicId: t.partner?.publicId ?? null,
      partnerName: t.partner?.name ?? 'System Direct',
      gatewayKey: t.gatewayKey,
      method: t.method,
      amount: t.amount,
      currency: t.currency,
      status: t.status,
      referenceNumber: t.referenceNumber,
      createdAt: t.createdAt,
    }));
  }

  /**
   * Partner list, unpaginated (capped at 100) — backs the partner-facing
   * B2B API (/payments), authenticated via API key.
   */
  async listForPartner(partnerId: string) {
    const transactions = await this.transactionRepository.find({
      where: { partnerId },
      order: { createdAt: 'DESC' },
      take: 100,
    });

    return transactions.map((t) => ({
      publicId: t.publicId,
      gatewayKey: t.gatewayKey,
      method: t.method,
      amount: t.amount,
      currency: t.currency,
      status: t.status,
      referenceNumber: t.referenceNumber,
      createdAt: t.createdAt,
    }));
  }

  /**
   * Partner list, paginated — backs the partner dashboard
   * (/dashboard/payments), authenticated via partner-user JWT.
   */
  async listForPartnerPaginated(
    partnerId: string,
    page: number,
    limit: number,
  ) {
    const [transactions, total] = await this.transactionRepository.findAndCount(
      {
        where: { partnerId },
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      },
    );

    return {
      items: transactions.map((t) => ({
        publicId: t.publicId,
        gatewayKey: t.gatewayKey,
        method: t.method,
        amount: t.amount,
        currency: t.currency,
        status: t.status,
        referenceNumber: t.referenceNumber,
        createdAt: t.createdAt,
      })),
      page,
      limit,
      total,
    };
  }

  private async toDetailResponse(transaction: PaymentTransactionEntity) {
    const partner = transaction.partnerId
      ? await this.partnerRepository.findOne({
          where: { id: transaction.partnerId },
        })
      : null;

    return {
      publicId: transaction.publicId,
      gatewayKey: transaction.gatewayKey,
      method: transaction.method,
      amount: transaction.amount,
      currency: transaction.currency,
      status: transaction.status,
      referenceNumber: transaction.referenceNumber,
      checkoutReturnUrl: buildCheckoutReturnUrl(
        partner?.checkoutReturnUrl,
        transaction.publicId,
      ),
      createdAt: transaction.createdAt,
    };
  }
}
