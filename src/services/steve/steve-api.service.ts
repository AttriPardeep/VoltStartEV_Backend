// src/services/steve/steve-api.service.ts
import logger from '../../config/logger.js';

export interface SteVeApiConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

export interface OcppTagForm {
  idTag: string;
  maxActiveTransactionCount?: number;
  expiryDate?: string; // ISO 8601 date-time
  parentIdTag?: string;
  note?: string;
}

export interface OcppTagOverview {
  ocppTagPk: number;
  idTag: string;
  parentIdTag?: string;
  expiryDate?: string;
  maxActiveTransactionCount: number;
  note?: string;
  userPk?: number;
  parentOcppTagPk?: number;
  blocked: boolean;
  inTransaction: boolean;
  activeTransactionCount: number;
}

export interface SteVeApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    status: number;
    message: string;
    details?: any;
  };
}

/**
 * Service for calling SteVe REST API endpoints
 * Handles authentication, retries, and error translation
 */
export class SteVeApiService {
  private config: SteVeApiConfig;
  private baseUrl: string;
  private authHeader: string;

  constructor(config: SteVeApiConfig) {
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.authHeader = `Basic ${Buffer.from(
      `${config.username}:${config.password}`
    ).toString('base64')}`;
  }

  private async fetch<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<SteVeApiResponse<T>> {
    const url = `${this.baseUrl}${endpoint}`;
    const timeout = this.config.timeoutMs || 10000;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': this.authHeader,
          ...options.headers,
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      let data: any;

      try {
        data = responseText ? JSON.parse(responseText) : null;
      } catch {
        data = responseText;
      }

      if (!response.ok) {
        logger.warn(`⚠️ SteVe API error ${response.status}`, {
          endpoint,
          method: options.method,
          response: data,
        });

        return {
          success: false,
          error: {
            status: response.status,
            message: `SteVe API ${response.status}: ${response.statusText}`,
            details: data,
          },
        };
      }

      return { success: true, data: data as T };
    } catch (error: any) {
      logger.error('💥 SteVe API request failed', {
        endpoint,
        error: error.message,
        code: error.code,
      });

      return {
        success: false,
        error: {
          status: 0,
          message: `Network error: ${error.message}`,
          details: error,
        },
      };
    }
  }

  // ─────────────────────────────────────────────────────
  // OCPP Tag Operations
  // ─────────────────────────────────────────────────────

  /**
   * Create a new OCPP tag via SteVe REST API
   * POST /api/v1/ocppTags
   */
  async createTag(tag: OcppTagForm): Promise<SteVeApiResponse<OcppTagOverview>> {
    logger.debug(`🏷️ Creating OCPP tag via API: ${tag.idTag}`);

    return await this.fetch<OcppTagOverview>('/api/v1/ocppTags', {
      method: 'POST',
      body: JSON.stringify(tag),
    });
  }

  /**
   * Update an existing OCPP tag via SteVe REST API
   * PUT /api/v1/ocppTags/{ocppTagPk}
   */
  async updateTag(
    ocppTagPk: number,
    tag: OcppTagForm
  ): Promise<SteVeApiResponse<OcppTagOverview>> {
    logger.debug(`🏷️ Updating OCPP tag via API: ${ocppTagPk}`);

    return await this.fetch<OcppTagOverview>(`/api/v1/ocppTags/${ocppTagPk}`, {
      method: 'PUT',
      body: JSON.stringify(tag),
    });
  }

  /**
   * Get tag details by ID via SteVe REST API
   * GET /api/v1/ocppTags?idTag={idTag}
   */
  async getTagByIdTag(
    idTag: string
  ): Promise<SteVeApiResponse<OcppTagOverview[]>> {
    logger.debug(`🔍 Fetching OCPP tag via API: ${idTag}`);

    return await this.fetch<OcppTagOverview[]>(
      `/api/v1/ocppTags?idTag=${encodeURIComponent(idTag)}`
    );
  }

  /**
   * Get tag details by primary key via SteVe REST API
   * GET /api/v1/ocppTags/{ocppTagPk}
   */
  async getTagByPk(
    ocppTagPk: number
  ): Promise<SteVeApiResponse<OcppTagOverview>> {
    logger.debug(`🔍 Fetching OCPP tag by PK via API: ${ocppTagPk}`);

    return await this.fetch<OcppTagOverview>(`/api/v1/ocppTags/${ocppTagPk}`);
  }

  /**
   * Delete an OCPP tag via SteVe REST API
   * DELETE /api/v1/ocppTags/{ocppTagPk}
   */
  async deleteTag(
    ocppTagPk: number
  ): Promise<SteVeApiResponse<OcppTagOverview>> {
    logger.debug(`🗑️ Deleting OCPP tag via API: ${ocppTagPk}`);

    return await this.fetch<OcppTagOverview>(`/api/v1/ocppTags/${ocppTagPk}`, {
      method: 'DELETE',
    });
  }

  // ─────────────────────────────────────────────────────
  // Helper Methods
  // ─────────────────────────────────────────────────────

  /**
   * Get or create a tag: fetch by idTag, create if not exists
   */
async getOrCreateTag(
  idTag: string,
  defaults?: Partial<OcppTagForm>
): Promise<SteVeApiResponse<OcppTagOverview>> {
  const getResult = await this.getTagByIdTag(idTag);

  // ✅ FIX: Check Array.isArray before accessing length
  if (getResult.success && Array.isArray(getResult.data) && getResult.data.length > 0) {
    logger.debug(`✅ Found existing tag: ${idTag}`);
    return { success: true, data: getResult.data[0] };
  }

  logger.debug(`🆕 Tag not found, creating: ${idTag}`);

  const createResult = await this.createTag({
    idTag,
    maxActiveTransactionCount: 1,
    note: defaults?.note || 'Provisioned by VoltStartEV app',
    ...defaults,
  });

  if (createResult.success) {
    logger.info(`✅ Created new tag: ${idTag} (PK: ${createResult.data?.ocppTagPk})`);
  }

  return createResult;
}
  /**
   * Check if a tag exists via SteVe REST API
   */
  async tagExists(idTag: string): Promise<boolean> {
    const result = await this.getTagByIdTag(idTag);
    return result.success && Array.isArray(result.data) && result.data.length > 0;
  }
}

// ─────────────────────────────────────────────────────
// Singleton Export
// ─────────────────────────────────────────────────────

export const steveApiService = new SteVeApiService({
  baseUrl: process.env.STEVE_API_URL || 'http://localhost:8080/steve',
  username: process.env.STEVE_API_USER || 'voltstart_backend',
  password: process.env.STEVE_API_PASS || '',
  timeoutMs: parseInt(process.env.STEVE_API_TIMEOUT_MS || '10000'),
});
