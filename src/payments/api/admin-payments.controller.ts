import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RoleKey } from '../../identity/domain/role-key.enum';
import { Roles } from '../../identity/infrastructure/decorators/roles.decorator';
import { GetPaymentUseCase } from '../application/get-payment.usecase';

@ApiTags('admin-payments')
@ApiBearerAuth()
@Roles(RoleKey.ADMIN, RoleKey.OPERATOR, RoleKey.AUDITOR)
@Controller('admin/payments')
export class AdminPaymentsController {
  constructor(private readonly getPaymentUseCase: GetPaymentUseCase) {}

  @Get()
  list() {
    return this.getPaymentUseCase.listForStaff();
  }

  @Get(':publicId')
  getOne(@Param('publicId') publicId: string) {
    return this.getPaymentUseCase.executeForStaff(publicId);
  }
}
