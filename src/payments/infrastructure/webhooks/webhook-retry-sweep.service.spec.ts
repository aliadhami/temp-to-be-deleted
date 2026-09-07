import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookDeliveryService } from './webhook-delivery.service';
import { WebhookRetrySweepService } from './webhook-retry-sweep.service';

describe('WebhookRetrySweepService', () => {
  let service: WebhookRetrySweepService;
  let deliveryService: { processDueDeliveries: jest.Mock };
  let configService: { getOrThrow: jest.Mock };

  const withSweeps = (enabled: boolean) =>
    configService.getOrThrow.mockReturnValue(enabled);

  beforeEach(async () => {
    deliveryService = {
      processDueDeliveries: jest.fn().mockResolvedValue(undefined),
    };
    configService = { getOrThrow: jest.fn().mockReturnValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookRetrySweepService,
        { provide: WebhookDeliveryService, useValue: deliveryService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(WebhookRetrySweepService);
  });

  it('runs the pass on a tick when sweeps are on', async () => {
    withSweeps(true);

    await service.tick();

    expect(deliveryService.processDueDeliveries).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a tick when sweeps are off', async () => {
    // `@Interval` registers at bootstrap and cannot be made conditional, so
    // the flag is read in the tick rather than at registration.
    withSweeps(false);

    await service.tick();

    expect(deliveryService.processDueDeliveries).not.toHaveBeenCalled();
  });

  it('leaves the pass callable while the timer is off', async () => {
    withSweeps(false);

    await service.sweep();

    expect(deliveryService.processDueDeliveries).toHaveBeenCalledTimes(1);
  });
});
