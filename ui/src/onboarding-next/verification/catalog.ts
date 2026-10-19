import type { ComponentType } from 'react';
import type { Inventory } from './discovery';
/** Replaced in memory by serve.ts after allowlisted discovery, never a production registry. */
export const views: Record<string, ComponentType<any>> = {};
export const host: { Entry: ComponentType<any>; previewConfiguration(options?: any): any } | null = null;
export const PebbleLayout: ComponentType<any> | null = null;
export const inventory: Inventory = { views: [], host: false, pebble: false, missing: [] };

export const candidate = { revision: '', tree: '', dirty: true };
