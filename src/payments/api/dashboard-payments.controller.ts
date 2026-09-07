import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { CurrentPartnerId } from '../../partners/infrastructure/decorators/current-partner-id.decorator';
import { PartnerScopeGuard } from '../../partners/infrastructure/partner-scope.guard';
import { UseGuards } from '@nestjs/common';
import { GetPaymentUseCase } from '../application/get-payment.usecase';
import { ListPaymentsQueryDto } from './dto/list-payments-query.dto';

@ApiTags('dashboard')
@ApiBearerAuth()
@Roles(RoleKey.PARTNER)
@UseGuards(PartnerScopeGuard)
@Controller('dashboard/payments')
export class DashboardPaymentsController {
  constructor(private readonly getPaymentUseCase: GetPaymentUseCase) {}

  @Get()
  list(
    @CurrentPartnerId() partnerId: string,
    @Query() query: ListPaymentsQueryDto,
  ) {
    return this.getPaymentUseCase.listForPartnerPaginated(
      partnerId,
      query.page ?? 1,
      query.limit ?? 20,
    );
  }

  @Get(':publicId')
  getOne(
    @CurrentPartnerId() partnerId: string,
    @Param('publicId') publicId: string,
  ) {
    return this.getPaymentUseCase.execute(partnerId, publicId);
  }
}
