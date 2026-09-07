import {
  CardholderEnrolmentResponseDto,
  CardholderResponseDto,
} from '../api/dto/cardholder-response.dto';
import { CardholderEnrolmentEntity } from '../infrastructure/persistence/cardholder-enrolment.entity';
import { CardholderEntity } from '../infrastructure/persistence/cardholder.entity';

const toEnrolmentResponse = (
  enrolment: CardholderEnrolmentEntity,
): CardholderEnrolmentResponseDto => ({
  providerKey: enrolment.providerKey,
  status: enrolment.status,
  reasonCode: enrolment.reasonCode,
  message: enrolment.message,
  createdAt: enrolment.createdAt,
});

/**
 * The one place a cardholder row becomes a response, shared by the list and
 * the member read so a field cannot be added to one and forgotten on the
 * other. Enrolments are passed in rather than read off the entity: the list
 * loads a page of them in one query.
 */
export const toCardholderResponse = (
  cardholder: CardholderEntity,
  enrolments: CardholderEnrolmentEntity[],
): CardholderResponseDto => ({
  publicId: cardholder.publicId,
  firstName: cardholder.firstName,
  lastName: cardholder.lastName,
  email: cardholder.email,
  enrolments: enrolments.map(toEnrolmentResponse),
  createdAt: cardholder.createdAt,
});
