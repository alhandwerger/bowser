/** Native polygon summaries: feature identity, request settings, and export data. */
import type { AppState, Overlay } from '../types';

export interface PolygonGeometry { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown[] }
export interface PolygonChoice { key: string; name: string; geometry: PolygonGeometry }
export type PolygonSupport = 'common' | 'per_date';
export interface PolygonBody {
  variable: string;
  geometry: PolygonGeometry;
  support: PolygonSupport;
  percentiles: number[];
  layer_masks: Array<{ dataset: string; threshold: number; mode: 'min' | 'max' }>;
  custom_mask_path?: string;
  primary_mask?: true;
  mask_min_value?: number;
  ref_lon?: number;
  ref_lat?: number;
  ref_buffer_m?: number;
}
export interface PolygonCall { url: string; body: PolygonBody }
export interface PolygonStatistics {
  count: number; mean: number | null; median: number | null;
  percentiles: Record<string, number | null>;
}
export interface PolygonResult {
  variable: string; labels: string[]; units: string | null;
  support: PolygonSupport;
  statistics: PolygonStatistics[]; polygon_pixels: number; common_pixels: number;
  reference: 'stored' | 'interactive'; optional_masks_applied: boolean;
  warnings: string[]; component_compatibility: string;
  reference_details?: { applied: boolean; longitude?: number; latitude?: number;
    buffer_meters?: number; offsets?: Array<number | null>; method?: string };
  masks: Array<{ kind: string; layer?: string; operator: string; threshold: number }>;
}

const anonymous = new WeakMap<object, number>();
let anonymousId = 0;
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const primitiveId = (x: unknown): x is string | number => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x));
const text = (x: unknown): string | null => typeof x === 'string' && x.trim() ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : null;
// Map features may carry altitude (especially KML); raster selection is 2D.
const planarCoordinates = (value: unknown): unknown => Array.isArray(value)
  ? typeof value[0] === 'number' && typeof value[1] === 'number'
    ? value.slice(0, 2) : value.map(planarCoordinates)
  : value;

/** Reuse unique feature IDs; otherwise keep object identity, never an array position. */
export function polygonChoices(overlays: Overlay[]): PolygonChoice[] {
  const choices: PolygonChoice[] = [];
  for (const overlay of overlays) {
    if (overlay.type !== 'vector' || !overlay.data) continue;
    const features = overlay.data.features.filter(record);
    const counts = new Map<string, number>();
    for (const f of features) {
      if (primitiveId(f.id)) {
        const key = JSON.stringify([typeof f.id, f.id]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    features.forEach((f, index) => {
      const g = f.geometry;
      if (!record(g) || !['Polygon', 'MultiPolygon'].includes(String(g.type)) || !Array.isArray(g.coordinates)) return;
      const id = primitiveId(f.id) ? JSON.stringify([typeof f.id, f.id]) : null;
      let identity: string;
      if (id !== null && counts.get(id) === 1) identity = `id:${id}`;
      else {
        if (!anonymous.has(f)) anonymous.set(f, ++anonymousId);
        identity = `object:${anonymous.get(f)}`;
      }
      const properties = record(f.properties) ? f.properties : {};
      const name = [properties.name, properties.Name, properties.title, f.id].map(text).find(x => x !== null) ?? `Polygon ${index + 1}`;
      choices.push({
        key: JSON.stringify([overlay.id, identity]),
        name: `${overlay.name} — ${name}${overlay.visible ? '' : ' (hidden)'}`,
        geometry: { type: g.type as PolygonGeometry['type'], coordinates: planarCoordinates(g.coordinates) as unknown[] },
      });
    });
  }
  return choices;
}

type PolygonState = Pick<AppState, 'currentDataset' | 'datasetInfo' | 'dataMode' | 'layerMasks' |
  'customMaskPath' | 'refEnabled' | 'refMarkerPosition' | 'refBufferEnabled' | 'refBufferRadius'>;

/** Forward active settings for the entire stored record, independent of the date slider. */
export function polygonRequest(state: PolygonState, geometry: PolygonGeometry, support: PolygonSupport,
  catalogId: string | null): PolygonCall | null {
  const info = state.datasetInfo[state.currentDataset];
  if (!state.currentDataset || !info) return null;
  const body: PolygonBody = {
    variable: state.currentDataset, geometry, support, percentiles: [10, 90],
    layer_masks: state.layerMasks.map(m => ({ dataset: m.dataset, threshold: m.threshold, mode: m.mode })),
  };
  if (state.customMaskPath) body.custom_mask_path = state.customMaskPath;
  if (state.dataMode === 'cog' && info.mask_file_list?.some(Boolean)) {
    body.primary_mask = true;
    body.mask_min_value = info.mask_min_value;
  }
  if (state.refEnabled && info.uses_spatial_ref && info.algorithm === 'shift') {
    [body.ref_lat, body.ref_lon] = state.refMarkerPosition;
    if (state.refBufferEnabled) body.ref_buffer_m = state.refBufferRadius;
  }
  const query = new URLSearchParams();
  if (catalogId) query.set('dataset', catalogId);
  const qs = query.toString();
  return { url: `/polygon_timeseries${qs ? `?${qs}` : ''}`, body };
}

/** Check that successful responses describe the requested layer and adjustments. */
export function polygonResponse(value: unknown, request: PolygonBody): PolygonResult {
  if (!record(value) || value.variable !== request.variable || !Array.isArray(value.labels)
    || !value.labels.every(x => typeof x === 'string') || !Array.isArray(value.statistics)
    || value.labels.length !== value.statistics.length || !value.labels.length
    || (value.units !== null && typeof value.units !== 'string')
    || !Array.isArray(value.warnings) || !value.warnings.every(x => typeof x === 'string')
    || value.support !== request.support || typeof value.component_compatibility !== 'string'
    || !Array.isArray(value.masks) || !Number.isInteger(value.polygon_pixels) || Number(value.polygon_pixels) < 0
    || !Number.isInteger(value.common_pixels) || Number(value.common_pixels) < 0
    || Number(value.common_pixels) > Number(value.polygon_pixels)) {
    throw new Error('The server returned an invalid polygon summary.');
  }
  const scalar = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));
  for (const row of value.statistics) {
    if (!record(row) || !Number.isInteger(row.count) || Number(row.count) < 0 || !scalar(row.mean)
      || !scalar(row.median) || !record(row.percentiles) || !scalar(row.percentiles['10']) || !scalar(row.percentiles['90'])) {
      throw new Error('The server returned invalid polygon statistics.');
    }
  }
  const referenced = request.ref_lon !== undefined;
  const masked = !!(request.primary_mask || request.custom_mask_path || request.layer_masks.length);
  if (value.reference !== (referenced ? 'interactive' : 'stored') || value.optional_masks_applied !== masked) {
    throw new Error('The server did not confirm the requested reference and masks.');
  }
  const maskCount = request.layer_masks.length + Number(!!request.primary_mask) + Number(!!request.custom_mask_path);
  if (value.masks.length !== maskCount) throw new Error('The server did not report every requested mask.');
  if (!value.masks.every(mask => record(mask) && typeof mask.kind === 'string'
    && typeof mask.operator === 'string' && typeof mask.threshold === 'number' && Number.isFinite(mask.threshold))) {
    throw new Error('The server returned invalid mask details.');
  }
  if (referenced && (!record(value.reference_details) || value.reference_details.applied !== true
    || value.reference_details.longitude !== request.ref_lon || value.reference_details.latitude !== request.ref_lat
    || value.reference_details.buffer_meters !== (request.ref_buffer_m ?? 0))) {
    throw new Error('The server did not confirm the selected reference position.');
  }
  return value as unknown as PolygonResult;
}

/** Quote CSV text safely while retaining numeric zeros and blank missing values. */
export function polygonCsv(result: PolygonResult): string {
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return '';
    let s = String(value);
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows: unknown[][] = [['label', 'layer', 'native_units', 'pixels', 'mean', 'median', 'p10', 'p90']];
  result.statistics.forEach((s, i) => rows.push([result.labels[i], result.variable, result.units,
    s.count, s.mean, s.median, s.percentiles['10'], s.percentiles['90']]));
  return rows.map(row => row.map(cell).join(',')).join('\n');
}

/** Save full result provenance without copying a server's local mask directory. */
export function polygonDetails(result: PolygonResult, request: PolygonCall | null, name: string): string {
  const { custom_mask_path, ...parameters } = request?.body ?? {};
  return JSON.stringify({
    feature_name: name,
    catalog_dataset: request ? new URL(request.url, 'http://localhost').searchParams.get('dataset') : null,
    parameters: { ...parameters, ...(custom_mask_path ? { custom_mask_file: custom_mask_path.split(/[\\/]/).pop() } : {}) },
    result,
  }, null, 2);
}
