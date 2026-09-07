import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ReconcileCardholdersUseCase } from '../application/reconcile-cardholders.usecase';
import { ReconcileCardholdersSweepService } from './reconcile-cardholders-sweep.service';

describe('ReconcileCardholdersSweepService', () => {
  let service: ReconcileCardholdersSweepService;
  let useCase: { execute: jest.Mock };
  let configService: { getOrThrow: jest.Mock };

  const withSweeps = (enabled: boolean) =>
    configService.getOrThrow.mockReturnValue(enabled);

  beforeEach(async () => {
    useCase = { execute: jest.fn().mockResolvedValue(undefined) };
    configService = { getOrThrow: jest.fn().mockReturnValue(true) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconcileCardholdersSweepService,
        { provide: ReconcileCardholdersUseCase, useValue: useCase },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(ReconcileCardholdersSweepService);
  });

  it('runs the pass on a tick when sweeps are on', async () => {
    withSweeps(true);

    await service.tick();

    expect(useCase.execute).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a tick when sweeps are off', async () => {
    // `@Interval` registers at bootstrap and cannot be made conditional, so
    // the flag is read in the tick rather than at registration.
    withSweeps(false);

    await service.tick();

    expect(useCase.execute).not.toHaveBeenCalled();
  });

  it('leaves the pass callable while the timer is off', async () => {
    // Kept separate from the tick so a caller that means to run it still can.
    withSweeps(false);

    await service.sweep();

    expect(useCase.execute).toHaveBeenCalledTimes(1);
  });
});
