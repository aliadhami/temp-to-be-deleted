import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { GetMerchantBalanceUseCase } from '../application/get-merchant-balance.usecase';
import { MerchantBalanceResponseDto } from './dto/merchant-balance-response.dto';
import { ProviderKeyQueryDto } from './dto/provider-key-query.dto';

/** Its own prefix, not one under `/admin/cards`, where `:publicId` would match it. */
@ApiTags('admin-cards')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN)
@Controller('admin/card-issuers')
export class AdminCardIssuersController {
  constructor(
    private readonly getMerchantBalanceUseCase: GetMerchantBalanceUseCase,
  ) {}

  @Get('merchant-balance')
  @ApiOkResponse({ type: MerchantBalanceResponseDto })
  merchantBalance(@Query() query: ProviderKeyQueryDto) {
    return this.getMerchantBalanceUseCase.execute(query.providerKey);
  }
}
