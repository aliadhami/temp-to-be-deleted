import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Public } from '../../identity/infrastructure/decorators/public.decorator';
import { ApiKeyScope } from '../../partners/domain/api-key-scope.enum';
import { RequireScope } from '../../partners/infrastructure/decorators/require-scope.decorator';
import type { PartnerAuthenticatedRequest } from '../../partners/infrastructure/partner-api-key.guard';
import { PartnerApiKeyGuard } from '../../partners/infrastructure/partner-api-key.guard';
import { ActivateCardUseCase } from '../application/activate-card.usecase';
import { GetCardDepositAddressUseCase } from '../application/get-card-deposit-address.usecase';
import { GetCardDepositsUseCase } from '../application/get-card-deposits.usecase';
import { GetCardUseCase } from '../application/get-card.usecase';
import { IssueCardUseCase } from '../application/issue-card.usecase';
import { ListCardProductsUseCase } from '../application/list-card-products.usecase';
import { ListCardTransactionsUseCase } from '../application/list-card-transactions.usecase';
import { QuoteCardDepositUseCase } from '../application/quote-card-deposit.usecase';
import { QuoteCardFundingUseCase } from '../application/quote-card-funding.usecase';
import { RequestCardDepositUseCase } from '../application/request-card-deposit.usecase';
import { UpdateCardPinUseCase } from '../application/update-card-pin.usecase';
import { UpdateCardStatusUseCase } from '../application/update-card-status.usecase';
import { CARD_ACTIVATE_ROUTE, CARDS_ROUTE_PREFIX } from './cards.routes';
import { ActivateCardDto } from './dto/activate-card.dto';
import { CardActivationResponseDto } from './dto/card-activation-response.dto';
import {
  CardDepositListResponseDto,
  CardDepositResponseDto,
} from './dto/card-deposit-response.dto';
import { CardDepositQuoteQueryDto } from './dto/card-deposit-quote-query.dto';
import { CardDepositQuoteResponseDto } from './dto/card-deposit-quote-response.dto';
import { CardFundingQuoteQueryDto } from './dto/card-funding-quote-query.dto';
import { CardFundingQuoteResponseDto } from './dto/card-funding-quote-response.dto';
import { CardProductListResponseDto } from './dto/card-product-response.dto';
import { CardStatusUpdateResponseDto } from './dto/card-status-update-response.dto';
import { CardListResponseDto, CardResponseDto } from './dto/card-response.dto';
import { CreateCardDepositDto } from './dto/create-card-deposit.dto';
import { ListCardDepositsQueryDto } from './dto/list-card-deposits-query.dto';
import { IssueCardDto } from './dto/issue-card.dto';
import {
  SensitiveCardDetailCardholderDirectResponseDto,
  SensitiveCardDetailFullResponseDto,
  SensitiveCardDetailHostedPageResponseDto,
  SensitiveCardDetailNumberOnlyResponseDto,
} from './dto/sensitive-card-detail-response.dto';
import { ListCardProductsQueryDto } from './dto/list-card-products-query.dto';
import { CardTransactionListResponseDto } from './dto/card-transaction-response.dto';
import { ListTransactionsQueryDto } from './dto/list-transactions-query.dto';
import { UpdateCardPinDto } from './dto/update-card-pin.dto';
import { UpdateCardStatusDto } from './dto/update-card-status.dto';
import { Throttle } from '@nestjs/throttler';
import { RevealSensitiveCardDetailsUseCase } from '../application/reveal-sensitive-card-details.usecase';
import { ListCardsQueryDto } from './dto/list-cards-query.dto';

@ApiTags('cards')
@ApiHeader({
  name: 'X-Api-Key',
  description: 'Partner API key (keyId.secret) — requires CARDS scope',
})
@Public()
@UseGuards(PartnerApiKeyGuard)
@RequireScope(ApiKeyScope.CARDS)
@Controller(CARDS_ROUTE_PREFIX)
export class CardsController {
  constructor(
    private readonly issueCardUseCase: IssueCardUseCase,
    private readonly activateCardUseCase: ActivateCardUseCase,
    private readonly getCardUseCase: GetCardUseCase,
    private readonly revealSensitiveCardDetailsUseCase: RevealSensitiveCardDetailsUseCase,
    private readonly getCardDepositAddressUseCase: GetCardDepositAddressUseCase,
    private readonly updateCardStatusUseCase: UpdateCardStatusUseCase,
    private readonly updateCardPinUseCase: UpdateCardPinUseCase,
    private readonly listCardTransactionsUseCase: ListCardTransactionsUseCase,
    private readonly listCardProductsUseCase: ListCardProductsUseCase,
    private readonly requestCardDepositUseCase: RequestCardDepositUseCase,
    private readonly getCardDepositsUseCase: GetCardDepositsUseCase,
    private readonly quoteCardFundingUseCase: QuoteCardFundingUseCase,
    private readonly quoteCardDepositUseCase: QuoteCardDepositUseCase,
  ) {}

  @Post('cardholders/:cardholderPublicId/cards')
  issue(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('cardholderPublicId') cardholderPublicId: string,
    @Body() dto: IssueCardDto,
  ) {
    return this.issueCardUseCase.execute({
      partnerId: request.partner.partnerId,
      cardholderPublicId,
      ...dto,
    });
  }

  /**
   * The route's request-body limit is raised beyond the framework default,
   * because the activation document is far larger than one — see
   * `applyCardActivationBodyLimit`, which mounts on `CARD_ACTIVATE_PATH`.
   */
  @ApiOkResponse({ type: CardActivationResponseDto })
  @Put(CARD_ACTIVATE_ROUTE)
  activate(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: ActivateCardDto,
  ) {
    return this.activateCardUseCase.execute({
      partnerId: request.partner.partnerId,
      cardPublicId: publicId,
      ...dto,
    });
  }

  @ApiOkResponse({ type: CardStatusUpdateResponseDto })
  @Put(':publicId/status')
  updateStatus(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: UpdateCardStatusDto,
  ) {
    return this.updateCardStatusUseCase.execute(
      request.partner.partnerId,
      publicId,
      dto.status,
      dto.reason,
    );
  }

  @Put(':publicId/pin')
  updatePin(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: UpdateCardPinDto,
  ) {
    return this.updateCardPinUseCase.execute(
      request.partner.partnerId,
      publicId,
      dto.oldPin,
      dto.newPin,
    );
  }

  /**
   * Tighter bucket than the app default, per Axys's own PCI rate limit for
   * this endpoint (10/min). The body is one of four shapes, so it is published
   * as a `oneOf` keyed on `kind`.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiExtraModels(
    SensitiveCardDetailFullResponseDto,
    SensitiveCardDetailNumberOnlyResponseDto,
    SensitiveCardDetailHostedPageResponseDto,
    SensitiveCardDetailCardholderDirectResponseDto,
  )
  @ApiOkResponse({
    description:
      'The card’s sensitive detail. Read `kind` before anything else — which shape arrives is decided by the issuer’s per-product setting, not by the request.',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(SensitiveCardDetailFullResponseDto) },
        { $ref: getSchemaPath(SensitiveCardDetailNumberOnlyResponseDto) },
        { $ref: getSchemaPath(SensitiveCardDetailHostedPageResponseDto) },
        { $ref: getSchemaPath(SensitiveCardDetailCardholderDirectResponseDto) },
      ],
      discriminator: { propertyName: 'kind' },
    },
  })
  @Get(':publicId/sensitive')
  async revealSensitive(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    const details = await this.revealSensitiveCardDetailsUseCase.execute(
      request.partner.partnerId,
      publicId,
    );
    return details.expose();
  }

  @Get(':publicId/deposit-address')
  getDepositAddress(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.getCardDepositAddressUseCase.execute(
      request.partner.partnerId,
      publicId,
    );
  }

  /**
   * Money onto a card that already exists — not the opening deposit, which is
   * a field on the request that issues a card. These three must stay declared
   * above `GET :publicId`.
   */
  /**
   * No per-route throttle, deliberately. A hardcoded bucket cannot be relaxed
   * per environment, which is the fault the login route already demonstrates —
   * its fixed bucket is a documented source of cross-suite test failures.
   */
  @ApiCreatedResponse({ type: CardDepositResponseDto })
  @Post(':publicId/deposits')
  requestDeposit(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: CreateCardDepositDto,
  ) {
    return this.requestCardDepositUseCase.execute({
      partnerId: request.partner.partnerId,
      cardPublicId: publicId,
      ...dto,
    });
  }

  @ApiOkResponse({ type: CardDepositListResponseDto })
  @Get(':publicId/deposits')
  listDeposits(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Query() query: ListCardDepositsQueryDto,
  ) {
    return this.getCardDepositsUseCase.listForCard(
      request.partner.partnerId,
      publicId,
      query.page ?? 1,
      query.limit ?? 20,
      query.status,
    );
  }

  @ApiOkResponse({ type: CardDepositResponseDto })
  @Get(':publicId/deposits/:depositPublicId')
  getDeposit(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Param('depositPublicId') depositPublicId: string,
  ) {
    return this.getCardDepositsUseCase.getOne(
      request.partner.partnerId,
      publicId,
      depositPublicId,
    );
  }

  /** **Stays declared above `GET :publicId`.** */
  @ApiOkResponse({
    type: CardDepositQuoteResponseDto,
    description:
      'What a top-up of this card costs, in the coin it is paid with. Carries no card fee — the card is open already. Indicative: it holds no rate and reserves nothing. The provider publishes no validity window, so a quote read now and paid later can cost a different amount — ask again immediately before paying.',
  })
  @Get(':publicId/deposit-quote')
  quoteDeposit(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Query() query: CardDepositQuoteQueryDto,
  ) {
    return this.quoteCardDepositUseCase.execute({
      partnerId: request.partner.partnerId,
      cardPublicId: publicId,
      amount: query.amount,
      network: query.network ?? null,
    });
  }

  @ApiOkResponse({ type: CardTransactionListResponseDto })
  @Get(':publicId/transactions')
  listTransactions(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Query() query: ListTransactionsQueryDto,
  ) {
    return this.listCardTransactionsUseCase.execute(
      request.partner.partnerId,
      publicId,
      query,
    );
  }

  @ApiOkResponse({ type: CardListResponseDto })
  @Get()
  list(
    @Req() request: PartnerAuthenticatedRequest,
    @Query() query: ListCardsQueryDto,
  ) {
    return this.getCardUseCase.listForPartner({
      // Ordering, not a guard: no query DTO here declares `partnerId` and the
      // global pipe strips undecorated keys, so nothing in `query` can reach
      // it today. Keep the spread first anyway — one that gains the field must
      // not be able to name its own partner.
      ...query,
      partnerId: request.partner.partnerId,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  /**
   * The catalogue a partner picks a product from. Not partner-scoped: a
   * catalogue belongs to a provider, and every partner sees the whole enabled
   * catalogue.
   */
  @ApiOkResponse({ type: CardProductListResponseDto })
  @Get('products')
  listProducts(@Query() query: ListCardProductsQueryDto) {
    return this.listCardProductsUseCase.execute({
      providerKey: query.providerKey,
      includeUnavailable: query.includeUnavailable ?? false,
    });
  }

  /**
   * What one card of this product costs to open. Not partner-scoped, for the
   * reason the catalogue read is not. **Stays declared above `GET :publicId`.**
   */
  @ApiOkResponse({
    type: CardFundingQuoteResponseDto,
    description:
      'What one card of this product costs to open, in the coin it is paid with. Indicative: it holds no rate and reserves nothing. The provider publishes no validity window, so a quote read now and paid later can cost a different amount — ask again immediately before paying.',
  })
  @Get('products/:publicId/funding-quote')
  quoteFunding(
    @Param('publicId') publicId: string,
    @Query() query: CardFundingQuoteQueryDto,
  ) {
    return this.quoteCardFundingUseCase.execute({
      cardProductPublicId: publicId,
      initialDepositAmount: query.initialDepositAmount,
      network: query.network ?? null,
    });
  }

  @ApiOkResponse({ type: CardResponseDto })
  @Get(':publicId')
  getOne(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.getCardUseCase.execute(request.partner.partnerId, publicId);
  }
}
