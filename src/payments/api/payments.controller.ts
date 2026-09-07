import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { Public } from '../../identity/infrastructure/decorators/public.decorator';
import { ApiKeyScope } from '../../partners/domain/api-key-scope.enum';
import { RequireScope } from '../../partners/infrastructure/decorators/require-scope.decorator';
import type { PartnerAuthenticatedRequest } from '../../partners/infrastructure/partner-api-key.guard';
import { PartnerApiKeyGuard } from '../../partners/infrastructure/partner-api-key.guard';
import { GetPaymentUseCase } from '../application/get-payment.usecase';
import { InitiatePaymentUseCase } from '../application/initiate-payment.usecase';
import { InitiatePaymentDto } from './dto/initiate-payment.dto';

@ApiTags('payments')
@ApiHeader({ name: 'X-Api-Key', description: 'Partner API key (keyId.secret)' })
@Public()
@UseGuards(PartnerApiKeyGuard)
@RequireScope(ApiKeyScope.PAYMENTS)
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly initiatePaymentUseCase: InitiatePaymentUseCase,
    private readonly getPaymentUseCase: GetPaymentUseCase,
  ) {}

  @Post()
  initiate(
    @Req() request: PartnerAuthenticatedRequest,
    @Body() dto: InitiatePaymentDto,
  ) {
    return this.initiatePaymentUseCase.execute({
      partnerId: request.partner.partnerId,
      ...dto,
    });
  }

  @Get()
  list(@Req() request: PartnerAuthenticatedRequest) {
    return this.getPaymentUseCase.listForPartner(request.partner.partnerId);
  }

  @Get(':publicId')
  getOne(
    @Req() request: PartnerAuthenticatedRequest,
    @Param('publicId') publicId: string,
  ) {
    return this.getPaymentUseCase.execute(request.partner.partnerId, publicId);
  }
}
