import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { EmulateKycValidationUseCase } from '../application/emulate-kyc-validation.usecase';
import { MockHyperCardConsumeUseCase } from '../application/mock-hypercard-consume.usecase';
import { MockHyperCardMerchantBalanceUseCase } from '../application/mock-hypercard-merchant-balance.usecase';
import { PrepareSpendOtpUseCase } from '../application/prepare-spend-otp.usecase';
import { SimulateCardDepositUseCase } from '../application/simulate-card-deposit.usecase';
import { SimulateCardSpendUseCase } from '../application/simulate-card-spend.usecase';
import { SyncCardholderStatusUseCase } from '../application/sync-cardholder-status.usecase';
import { EmulateKycValidationDto } from './dto/emulate-kyc-validation.dto';
import { MockHyperCardConsumeDto } from './dto/mock-hypercard-consume.dto';
import { ProviderKeyQueryDto } from './dto/provider-key-query.dto';
import { SimulateCryptoDepositDto } from './dto/simulate-crypto-deposit.dto';
import { SimulateSpendDto } from './dto/simulate-spend.dto';

@ApiTags('admin-cards')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN)
@Controller('admin/cards/emulation')
export class AdminCardEmulationController {
  constructor(
    private readonly emulateKycValidationUseCase: EmulateKycValidationUseCase,
    private readonly syncCardholderStatusUseCase: SyncCardholderStatusUseCase,
    private readonly simulateCardDepositUseCase: SimulateCardDepositUseCase,
    private readonly simulateCardSpendUseCase: SimulateCardSpendUseCase,
    private readonly prepareSpendOtpUseCase: PrepareSpendOtpUseCase,
    private readonly mockHyperCardConsumeUseCase: MockHyperCardConsumeUseCase,
    private readonly mockHyperCardMerchantBalanceUseCase: MockHyperCardMerchantBalanceUseCase,
  ) {}

  @Post('kyc-validate/:cardholderPublicId')
  validateKyc(
    @Param('cardholderPublicId') cardholderPublicId: string,
    @Body() dto: EmulateKycValidationDto,
  ) {
    return this.emulateKycValidationUseCase.execute(
      cardholderPublicId,
      dto.providerKey,
      dto.result,
    );
  }

  @Get('sync-status/:cardholderPublicId')
  syncStatus(
    @Param('cardholderPublicId') cardholderPublicId: string,
    @Query() query: ProviderKeyQueryDto,
  ) {
    return this.syncCardholderStatusUseCase.execute(
      cardholderPublicId,
      query.providerKey,
    );
  }

  @Post('simulate-deposit/:cardPublicId')
  simulateDeposit(
    @Param('cardPublicId') cardPublicId: string,
    @Body() dto: SimulateCryptoDepositDto,
  ) {
    return this.simulateCardDepositUseCase.execute(
      cardPublicId,
      dto.address,
      dto.tokenId,
      dto.amount,
    );
  }

  @Post('simulate-spend/:cardPublicId')
  simulateSpend(
    @Param('cardPublicId') cardPublicId: string,
    @Body() dto: SimulateSpendDto,
  ) {
    return this.simulateCardSpendUseCase.execute(cardPublicId, dto.amount);
  }

  @Post('prepare-spend-otp/:cardPublicId')
  prepareSpendOtp(@Param('cardPublicId') cardPublicId: string) {
    return this.prepareSpendOtpUseCase.execute(cardPublicId);
  }

  /** The routes above name no issuer and reach Axys whatever the card's issuer is. */
  @Post('hypercard/mock-consume/:cardPublicId')
  mockHyperCardConsume(
    @Param('cardPublicId') cardPublicId: string,
    @Body() dto: MockHyperCardConsumeDto,
  ) {
    return this.mockHyperCardConsumeUseCase.execute(cardPublicId, dto);
  }

  /** Their endpoint takes no parameters, so a body sent anyway is ignored, not refused. */
  @Post('hypercard/add-merchant-balance')
  addHyperCardMerchantBalance() {
    return this.mockHyperCardMerchantBalanceUseCase.execute();
  }
}
