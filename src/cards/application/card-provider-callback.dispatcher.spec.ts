import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardCallbackEvent } from '../domain/card-issuer.port';
import { CardProviderCatalogueUnavailableError } from '../domain/card-provider-catalogue-unavailable.error';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardStatus } from '../domain/card-status.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { ApplyIssuerCardStatusUseCase } from './apply-issuer-card-status.usecase';
import { CardProviderCallbackDispatcher } from './card-provider-callback.dispatcher';
import { ResolveCardApplicationsUseCase } from './resolve-card-applications.usecase';
import { ResolveCardDepositsUseCase } from './resolve-card-deposits.usecase';
import { ResolveCardOperationsUseCase } from './resolve-card-operations.usecase';
import { SyncCardProductsUseCase } from './sync-card-products.usecase';

/** The canonical UUID form every reference arm arrives in. */
const REFERENCE = '0b03f62e-b9eb-4b72-b482-2288de5b2848';

/** Their own id for a card, which the status arm arrives with instead. */
const PROVIDER_CARD_ID = '6232931889900031321';

describe('CardProviderCallbackDispatcher', () => {
  let dispatcher: CardProviderCallbackDispatcher;
  let applications: { resolveOneByRequestId: jest.Mock };
  let deposits: { resolveOneByProviderReference: jest.Mock };
  let operations: { resolveOneByRequestReference: jest.Mock };
  let cardStatus: { execute: jest.Mock };
  let cardProducts: { execute: jest.Mock };
  let registry: { keysWithCapability: jest.Mock };
  let warn: jest.SpyInstance;

  const dispatch = (event: CardCallbackEvent): Promise<void> =>
    dispatcher.dispatch(CardProviderKey.HYPERCARD, event);

  beforeEach(async () => {
    warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    applications = { resolveOneByRequestId: jest.fn(() => 'RESOLVED') };
    deposits = { resolveOneByProviderReference: jest.fn(() => 'RESOLVED') };
    operations = { resolveOneByRequestReference: jest.fn(() => 'RESOLVED') };
    cardStatus = { execute: jest.fn(() => 'RESOLVED') };
    cardProducts = { execute: jest.fn() };
    registry = {
      keysWithCapability: jest.fn(() => [CardProviderKey.HYPERCARD]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CardProviderCallbackDispatcher,
        { provide: ResolveCardApplicationsUseCase, useValue: applications },
        { provide: ResolveCardDepositsUseCase, useValue: deposits },
        { provide: ResolveCardOperationsUseCase, useValue: operations },
        { provide: ApplyIssuerCardStatusUseCase, useValue: cardStatus },
        { provide: SyncCardProductsUseCase, useValue: cardProducts },
        { provide: CardIssuerRegistry, useValue: registry },
      ],
    }).compile();

    dispatcher = module.get(CardProviderCallbackDispatcher);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('an application outcome', () => {
    it('resolves the row scoped to the provider it arrived on', async () => {
      await dispatch({ kind: 'APPLICATION', reference: REFERENCE });

      expect(applications.resolveOneByRequestId).toHaveBeenCalledWith(
        CardProviderKey.HYPERCARD,
        REFERENCE,
        // The issuer announced it, which is a different fact from a timer
        // having noticed.
        CardEventSource.CALLBACK,
      );
    });

    it('acknowledges a reference this database does not hold', async () => {
      // An issuer account holds one callback address, so an environment can
      // receive another's events.
      applications.resolveOneByRequestId.mockReturnValue('NO_ROW');

      await expect(
        dispatch({ kind: 'APPLICATION', reference: REFERENCE }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(REFERENCE) as string,
      );
    });

    it('says a row is here but unlookupable, distinctly from absent', async () => {
      applications.resolveOneByRequestId.mockReturnValue('UNRESOLVABLE');

      await dispatch({ kind: 'APPLICATION', reference: REFERENCE });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('no issuer id') as string,
      );
    });

    it('lets a failed resolution escape, so the delivery stays unprocessed', async () => {
      applications.resolveOneByRequestId.mockRejectedValue(
        new Error('the issuer timed out'),
      );

      await expect(
        dispatch({ kind: 'APPLICATION', reference: REFERENCE }),
      ).rejects.toThrow('the issuer timed out');
    });
  });

  describe('a deposit outcome', () => {
    it('resolves on the reference the deposit was submitted under', async () => {
      // Reverses to `provider_reference`, never the partner's `request_id`.
      await dispatch({ kind: 'DEPOSIT', reference: REFERENCE });

      expect(deposits.resolveOneByProviderReference).toHaveBeenCalledWith(
        CardProviderKey.HYPERCARD,
        REFERENCE,
      );
    });

    it('acknowledges a reference this database does not hold', async () => {
      deposits.resolveOneByProviderReference.mockReturnValue('NO_ROW');

      await expect(
        dispatch({ kind: 'DEPOSIT', reference: REFERENCE }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('a lifecycle operation outcome', () => {
    it('resolves the row scoped to the provider it arrived on', async () => {
      await dispatch({ kind: 'OPERATION', reference: REFERENCE });

      expect(operations.resolveOneByRequestReference).toHaveBeenCalledWith(
        CardProviderKey.HYPERCARD,
        REFERENCE,
        CardEventSource.CALLBACK,
      );
    });

    it('acknowledges a reference this database does not hold', async () => {
      operations.resolveOneByRequestReference.mockReturnValue('NO_ROW');

      await expect(
        dispatch({ kind: 'OPERATION', reference: REFERENCE }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('a status the issuer changed itself', () => {
    it('applies it to the card that issuer holds', async () => {
      await dispatch({
        kind: 'CARD_STATUS',
        providerCardId: PROVIDER_CARD_ID,
        status: CardStatus.ON_HOLD,
      });

      expect(cardStatus.execute).toHaveBeenCalledWith(
        CardProviderKey.HYPERCARD,
        PROVIDER_CARD_ID,
        CardStatus.ON_HOLD,
      );
      // Nothing is asked of the issuer here: the status arrives already read,
      // and no lookup of theirs answers on a card's status.
      expect(applications.resolveOneByRequestId).not.toHaveBeenCalled();
      expect(operations.resolveOneByRequestReference).not.toHaveBeenCalled();
    });

    it('acknowledges a card this database does not hold', async () => {
      cardStatus.execute.mockReturnValue('NO_ROW');

      await expect(
        dispatch({
          kind: 'CARD_STATUS',
          providerCardId: PROVIDER_CARD_ID,
          status: CardStatus.ON_HOLD,
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(PROVIDER_CARD_ID) as string,
      );
    });

    it('lets a failed write escape, so the delivery stays unprocessed', async () => {
      cardStatus.execute.mockRejectedValue(new Error('the server rolled back'));

      await expect(
        dispatch({
          kind: 'CARD_STATUS',
          providerCardId: PROVIDER_CARD_ID,
          status: CardStatus.ON_HOLD,
        }),
      ).rejects.toThrow('the server rolled back');
    });
  });

  describe('a product the issuer changed', () => {
    it('refreshes the whole catalogue of the provider it arrived on, once', async () => {
      await dispatch({ kind: 'PRODUCT_CATALOGUE' });

      expect(cardProducts.execute).toHaveBeenCalledTimes(1);
      expect(cardProducts.execute).toHaveBeenCalledWith(
        CardProviderKey.HYPERCARD,
      );
      expect(applications.resolveOneByRequestId).not.toHaveBeenCalled();
      expect(deposits.resolveOneByProviderReference).not.toHaveBeenCalled();
      expect(operations.resolveOneByRequestReference).not.toHaveBeenCalled();
      expect(cardStatus.execute).not.toHaveBeenCalled();
    });

    it('lets a failed refresh escape, so the delivery stays unprocessed', async () => {
      cardProducts.execute.mockRejectedValue(
        new CardProviderCatalogueUnavailableError(CardProviderKey.HYPERCARD),
      );

      await expect(dispatch({ kind: 'PRODUCT_CATALOGUE' })).rejects.toThrow(
        CardProviderCatalogueUnavailableError,
      );
    });

    it('acknowledges a provider publishing no catalogue, without asking for one', async () => {
      registry.keysWithCapability.mockReturnValue([]);

      await expect(
        dispatch({ kind: 'PRODUCT_CATALOGUE' }),
      ).resolves.toBeUndefined();
      expect(registry.keysWithCapability).toHaveBeenCalledWith(
        CardCapability.PRODUCT_CATALOGUE,
      );
      // Refusing would earn their whole retry ladder for something permanent.
      expect(cardProducts.execute).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('an event nothing here acts on', () => {
    it('does nothing with an event type this codebase has no use for', async () => {
      await dispatch({ kind: 'UNHANDLED', label: 'OPT_CODE' });

      expect(applications.resolveOneByRequestId).not.toHaveBeenCalled();
      expect(deposits.resolveOneByProviderReference).not.toHaveBeenCalled();
      expect(operations.resolveOneByRequestReference).not.toHaveBeenCalled();
      expect(cardStatus.execute).not.toHaveBeenCalled();
      expect(cardProducts.execute).not.toHaveBeenCalled();
    });
  });
});
