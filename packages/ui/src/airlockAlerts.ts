/**
 * GH-294 TEL-2: an Airlock alert's category in words, shared by the board's
 * alert banner and a card's Airlock section. The categories are core's
 * AIRLOCK_ALERTS (airlockAlertOf), which the board cannot import.
 */
import type { AirlockAlertDto } from './api';

export const AIRLOCK_ALERT_LABEL: Record<AirlockAlertDto, string> = {
  'metadata-endpoint': 'Cloud metadata endpoint',
  'ioc-host': 'Indicator-of-compromise host',
  'cloud-storage': 'Cloud storage upload',
};

export const isAirlockAlert = (v: unknown): v is AirlockAlertDto =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(AIRLOCK_ALERT_LABEL, v);
