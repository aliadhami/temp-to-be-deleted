import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  WebhookDeliveryEntity,
  WebhookDeliveryStatus,
} from '../infrastructure/webhooks/webhook-delivery.entity';

@Injectable()
export class WebhookDeliveriesQueryService {
  constructor(
    @InjectRepository(WebhookDeliveryEntity)
    private readonly deliveryRepository: Repository<WebhookDeliveryEntity>,
  ) {}

  async list(status?: string) {
    const where = status ? { status: status as WebhookDeliveryStatus } : {};
    return this.deliveryRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: 100,
    });
  }

  async retryDeadLetter(publicId: string): Promise<{ status: 'requeued' }> {
    const delivery = await this.deliveryRepository.findOne({
      where: { publicId },
    });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    delivery.status = WebhookDeliveryStatus.PENDING;
    delivery.attemptCount = 0;
    delivery.nextAttemptAt = new Date();
    await this.deliveryRepository.save(delivery);
    return { status: 'requeued' };
  }

  async listForPartner(
    partnerId: string,
    page: number,
    limit: number,
    status?: WebhookDeliveryStatus,
  ) {
    const where = status ? { partnerId, status } : { partnerId };
    const [items, total] = await this.deliveryRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      items: items.map((d) => ({
        publicId: d.publicId,
        eventType: d.eventType,
        status: d.status,
        attemptCount: d.attemptCount,
        lastResponseStatus: d.lastResponseStatus,
        lastError: d.lastError,
        deliveredAt: d.deliveredAt,
        createdAt: d.createdAt,
      })),
      page,
      limit,
      total,
    };
  }

  async getOneForPartner(partnerId: string, publicId: string) {
    const delivery = await this.deliveryRepository.findOne({
      where: { publicId, partnerId },
    });
    if (!delivery) throw new NotFoundException('Webhook delivery not found');

    return {
      publicId: delivery.publicId,
      eventType: delivery.eventType,
      payload: delivery.payload,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastResponseStatus: delivery.lastResponseStatus,
      lastError: delivery.lastError,
      deliveredAt: delivery.deliveredAt,
      createdAt: delivery.createdAt,
    };
  }
}
