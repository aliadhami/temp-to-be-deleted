import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../identity/infrastructure/decorators/public.decorator';
import { ApiKeyScope } from '../../partners/domain/api-key-scope.enum';
import { RequireScope } from '../../partners/infrastructure/decorators/require-scope.decorator';
import type { PartnerAuthenticatedRequest } from '../../partners/infrastructure/partner-api-key.guard';
import { PartnerApiKeyGuard } from '../../partners/infrastructure/partner-api-key.guard';
import { EnrolCardholderUseCase } from '../application/enrol-cardholder.usecase';
import { GetCardholderUseCase } from '../application/get-cardholder.usecase';
import { OnboardCardholderUseCase } from '../application/onboard-cardholder.usecase';
import { SubmitKycUseCase } from '../application/submit-kyc.usecase';
import {
  CardholderListResponseDto,
  CardholderResponseDto,
} from './dto/cardholder-response.dto';
import { EnrolCardholderDto } from './dto/enrol-cardholder.dto';
import { OnboardCardholderDto } from './dto/onboard-cardholder.dto';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { Query } from '@nestjs/common';
import { ListCardholdersQueryDto } from './dto/list-cardholders-query.dto';

@ApiTags('cards')
@ApiHeader({
  name: 'X-Api-Key',
  description: 'Partner API key (keyId.secret) — requires CARDS scope',
})
@Public()
@UseGuards(PartnerApiKeyGuard)
@RequireScope(ApiKeyScope.CARDS)
@Controller('cards/cardholders')
export class CardholdersController {
  constructor(
    private readonly onboardCardholderUseCase: OnboardCardholderUseCase,
    private readonly enrolCardholderUseCase: EnrolCardholderUseCase,
    private readonly submitKycUseCase: SubmitKycUseCase,
    private readonly getCardholderUseCase: GetCardholderUseCase,
  ) {}

  @Post()
  onboard(
    @Req() request: PartnerAuthenticatedRequest,
    @Body() dto: OnboardCardholderDto,
  ) {
    return this.onboardCardholderUseCase.execute({
      partnerId: request.partner.partnerId,
      ...dto,
    });
  }

  /** Puts a cardholder who already exists to a further issuer. */
  @Post(':publicId/enrolments')
  enrol(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: EnrolCardholderDto,
  ) {
    return this.enrolCardholderUseCase.execute({
      partnerId: request.partner.partnerId,
      cardholderPublicId: publicId,
      providerKey: dto.providerKey,
    });
  }

  @Post(':publicId/kyc-submit')
  submitKyc(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
    @Body() dto: SubmitKycDto,
  ) {
    return this.submitKycUseCase.execute(
      request.partner.partnerId,
      publicId,
      dto.providerKey,
    );
  }

  @ApiOkResponse({ type: CardholderListResponseDto })
  @Get()
  list(
    @Req() request: PartnerAuthenticatedRequest,
    @Query() query: ListCardholdersQueryDto,
  ) {
    return this.getCardholderUseCase.listForPartner({
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

  @ApiOkResponse({ type: CardholderResponseDto })
  @Get(':publicId')
  getOne(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.getCardholderUseCase.execute(
      request.partner.partnerId,
      publicId,
    );
  }
}
