// src/services/ocpp/tag-provisioning.service.ts
import { steveRepository } from '../../repositories/steve-repository.js';

export async function provisionOcppTagInSteVe(
  idTag: string, 
  options?: {
    maxActiveTransactions?: number;
    expiryDate?: Date;
    note?: string;
  }
): Promise<{ ocppTagPk: number }> {
  // Use repository method - no direct SQL in this file
  return await steveRepository.upsertTag({
    idTag,
    maxActiveTransactions: options?.maxActiveTransactions,
    expiryDate: options?.expiryDate,
    note: options?.note || 'Provisioned by VoltStartEV app'
  });
}
