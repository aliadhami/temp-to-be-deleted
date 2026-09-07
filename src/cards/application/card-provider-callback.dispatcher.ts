import { Injectable, Logger } from '@nestjs/common';
import { CardCapability } from '../domain/card-capability.enum';
import { CardEventSource } from '../domain/card-event-source.enum';
import { CardCallbackEvent } from '../domain/card-issuer.port';
import { CardProviderKey } from '../domain/card-provider-key.enum';
import { CardIssuerRegistry } from '../infrastructure/card-issuer-registry';
import { ApplyIssuerCardStatusUseCase } from './apply-issuer-card-status.usecase';
import {
  CardCallbackResolution,
  providerReportsOutcome,
} from './card-callback-resolution';
import { ResolveCardApplicationsUseCase } from './resolve-card-applications.usecase';
import { ResolveCardDepositsUseCase } from './resolve-card-deposits.usecase';
import { ResolveCardOperationsUseCase } from './resolve-card-operations.usecase';
import { SyncCardProductsUseCase } from './sync-card-products.usecase';

/**
 * Acts on one verified callback.
 *
 * **Every arm asks the issuer what became of the thing rather than reading it
 * off the payload**; only the status arm keeps a fallback, for want of a lookup
 * addressable by card. A throw leaves the delivery unprocessed for their retry.
 */
@Injectable()
export class CardProviderCallbackDispatcher {
  private readonly logger = new Logger(CardProviderCallbackDispatcher.name);

  constructor(
    private readonly resolveCardApplications: ResolveCardApplicationsUseCase,
    private readonly resolveCardDeposits: ResolveCardDepositsUseCase,
    private readonly resolveCardOperations: ResolveCardOperationsUseCase,
    private readonly applyIssuerCardStatus: ApplyIssuerCardStatusUseCase,
    private readonly syncCardProducts: SyncCardProductsUseCase,
    private readonly cardIssuerRegistry: CardIssuerRegistry,
  ) {}

  /**
   * Every lookup is scoped to the provider the delivery arrived on — a
   * reference is a UUID and collision is not the risk, a handler reaching
   * another issuer's row is.
   */
  async dispatch(
    providerKey: CardProviderKey,
    event: CardCallbackEvent,
  ): Promise<void> {
    switch (event.kind) {
      case 'APPLICATION':
        return this.report(
          providerKey,
          'card application',
          event.reference,
          await this.resolveCardApplications.resolveOneByRequestId(
            providerKey,
            event.reference,
            CardEventSource.CALLBACK,
          ),
        );

      case 'DEPOSIT':
        return this.report(
          providerKey,
          'card deposit',
          event.reference,
          await this.resolveCardDeposits.resolveOneByProviderReference(
            providerKey,
            event.reference,
          ),
        );

      case 'OPERATION':
        return this.report(
          providerKey,
          'card operation',
          event.reference,
          await this.resolveCardOperations.resolveOneByRequestReference(
            providerKey,
            event.reference,
            CardEventSource.CALLBACK,
          ),
        );

      case 'CARD_STATUS': {
        const resolution = await this.applyIssuerCardStatus.execute(
          providerKey,
          event.providerCardId,
          event.status,
        );

        if (resolution === 'NO_ROW') {
          this.logger.warn(
            `A ${providerKey} callback announces a status change on card ${event.providerCardId}, which this database does not hold — acknowledged and ignored`,
          );
        }
        return;
      }

      case 'PRODUCT_CATALOGUE': {
        if (
          !providerReportsOutcome(
            this.cardIssuerRegistry,
            CardCapability.PRODUCT_CATALOGUE,
            providerKey,
          )
        ) {
          this.logger.warn(
            `A ${providerKey} callback announces a product change, and no catalogue of that provider's is published here — acknowledged and ignored`,
          );
          return;
        }

        // Never narrowed to the product their event names.
        await this.syncCardProducts.execute(providerKey);
        return;
      }

      case 'UNHANDLED':
        // Recorded and acknowledged; nothing here acts on it.
        return;
    }

    // A new arm on the union stops compiling here rather than being silently
    // acknowledged.
    const unreachable: never = event;
    throw new Error(
      `No handler for card provider callback event ${JSON.stringify(unreachable)}`,
    );
  }

  /**
   * **A reference this database does not hold is ordinary traffic**: an issuer
   * account carries one callback address, so whichever environment holds it
   * receives every environment's events.
   */
  private report(
    providerKey: CardProviderKey,
    what: string,
    reference: string,
    resolution: CardCallbackResolution,
  ): void {
    if (resolution === 'RESOLVED') return;

    this.logger.warn(
      resolution === 'NO_ROW'
        ? `A ${providerKey} callback names ${what} ${reference}, which this database holds no outstanding row for — acknowledged and ignored`
        : `A ${providerKey} callback names ${what} ${reference}, which is here but names a card carrying no issuer id — acknowledged, and nothing could be looked up`,
    );
  }
}
