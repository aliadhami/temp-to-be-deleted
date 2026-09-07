import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardholderStatus } from '../domain/cardholder-status.enum';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderStatusSyncService } from './cardholder-status-sync.service';

const NON_TERMINAL_STATUSES = [
  CardholderStatus.PENDING,
  CardholderStatus.UNDER_REVIEW,
];

@Injectable()
export class ReconcileCardholdersUseCase {
  private readonly logger = new Logger(ReconcileCardholdersUseCase.name);

  constructor(
    @InjectRepository(CardholderEnrolmentEntity)
    private readonly enrolmentRepository: Repository<CardholderEnrolmentEntity>,
    private readonly statusSyncService: CardholderStatusSyncService,
  ) {}

  async execute(): Promise<void> {
    const pending = await this.enrolmentRepository.find({
      where: { status: In(NON_TERMINAL_STATUSES) },
      take: 50,
    });

    for (const enrolment of pending) {
      try {
        await this.statusSyncService.syncOne(
          enrolment,
          CardEventSource.RECONCILE,
        );
      } catch (error) {
        this.logger.warn(
          `Reconcile failed for cardholder ${enrolment.cardholderId} on ${enrolment.providerKey}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
