import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntity } from './audit-log.entity';

export interface RecordAuditEventInput {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetPublicId?: string;
  beforeJson?: Record<string, unknown>;
  afterJson?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLogEntity)
    private readonly auditLogRepository: Repository<AuditLogEntity>,
  ) {}

  async record(input: RecordAuditEventInput): Promise<void> {
    const row = this.auditLogRepository.create({
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetPublicId: input.targetPublicId ?? null,
      beforeJson: input.beforeJson ?? null,
      afterJson: input.afterJson ?? null,
    });
    // Audit writes must never silently fail a real business operation, but
    // they also must never be allowed to abort one — log the row on its own,
    // and let the caller decide whether a persistence failure here is fatal.
    await this.auditLogRepository.save(row);
  }
}
