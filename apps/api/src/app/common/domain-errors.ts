import { OrganizationStoreError, Prisma } from '@acra/database';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalAdminError } from '../../admin/approvals-admin';

/**
 * Maps domain/store errors to HTTP errors. Messages of these errors are written by us (never
 * driver or provider output), so they are safe to show. Anything else is rethrown and becomes a
 * generic 500 in AllExceptionsFilter.
 */
export function toHttpError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof OrganizationStoreError) {
    switch (error.code) {
      case 'not_found':
        throw new NotFoundException(error.message);
      case 'last_owner':
        throw new ConflictException(error.message);
      case 'slug_taken':
      case 'already_member':
        throw new ConflictException(error.message);
    }
  }
  if (error instanceof ApprovalAdminError) {
    if (/not found/i.test(error.message)) throw new NotFoundException(error.message);
    if (/not a member|may not approve|human user/i.test(error.message)) throw new ForbiddenException(error.message);
    if (/concurrently|newer commit|expired|no longer|request that is|commit changed/i.test(error.message))
      throw new ConflictException(error.message);
    throw new BadRequestException(error.message);
  }
  // Serializable transaction conflict (concurrent role changes): ask the client to retry.
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    throw new ConflictException('The data was changed concurrently. Please try again.');
  }
  throw error;
}

/** Runs an operation and converts known domain errors. */
export async function mapErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    return toHttpError(error);
  }
}
