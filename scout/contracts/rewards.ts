/** Rewards foundation: programs, balances, transfers, award quotes, friction. */

import type { EntityId } from './ids.ts';
import type { Confidence } from './confidence.ts';
import type { RegionCode } from './entities.ts';

export const PROGRAM_KINDS = ['airline', 'hotel', 'bank', 'rail'] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];

export interface LoyaltyProgram {
  id: EntityId; name: string; kind: ProgramKind;
  currencyName: string; regionCode: RegionCode | null;
}

export interface TransferPartner {
  id: string;
  fromProgramId: EntityId;
  toProgramId: EntityId;
  /** ratioNum points out produce ratioDen points in. 1000:1000 is 1:1. */
  ratioNum: number;
  ratioDen: number;
  minTransfer: number;
  transferTimeHours: number;
  active: boolean;
}

export interface UserBalance {
  id: string; userId: EntityId; programId: EntityId;
  balance: number; updatedAt: string;
}

export interface AwardQuote {
  id: string;
  userId: EntityId | null;
  originAirportId: EntityId;
  destinationAirportId: EntityId;
  programId: EntityId;
  pointsCost: number;
  taxesCents: number;
  cashCents: number;
  /** Cents of value per point: (cashCents - taxesCents) / pointsCost. */
  centsPerPoint: number;
  confidence: Confidence;
  quotedAt: string;
}

/**
 * A transfer route from balances the user actually holds to the program that
 * can book the award, with the safety checks that stop a one-way mistake.
 */
export interface TransferPlan {
  toProgramId: EntityId;
  steps: {
    fromProgramId: EntityId; toProgramId: EntityId;
    pointsOut: number; pointsIn: number; transferTimeHours: number;
  }[];
  totalPointsFromUser: number;
  pointsDelivered: number;
  shortfall: number;
  /** Transfers are irreversible; these must be surfaced before any action. */
  warnings: string[];
  feasible: boolean;
}

/**
 * Travel friction: how unpleasant an itinerary is, independent of price.
 * 0 is a nonstop at a civil hour; 1 is a multi-stop overnight ordeal.
 */
export interface TravelFriction {
  originAirportId: EntityId;
  destinationAirportId: EntityId;
  stops: number;
  totalMinutes: number;
  overnight: boolean;
  redeye: boolean;
  score: number;
  factors: { label: string; contribution: number }[];
}
