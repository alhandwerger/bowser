import type { AppState, Overlay, RasterGroup } from '../types';
import type { PolygonBody, PolygonGeometry, PolygonResult } from '../map/polygonAnalysis';

export const geometry: PolygonGeometry = { type: 'Polygon', coordinates: [
  [[10, 45], [10.1, 45], [10.1, 45.1], [10, 45.1], [10, 45]],
] };
export const imported: Overlay = {
  id: 'imported', name: 'Imported features', type: 'vector', visible: true, opacity: 1,
  data: { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 0, geometry, properties: { name: 'Example polygon' } },
    { type: 'Feature', id: 'point', geometry: { type: 'Point', coordinates: [10, 45] }, properties: { name: 'Point' } },
  ] },
};
export const drawn: Overlay = {
  ...imported, id: 'drawings', name: 'Drawings', data: { type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'drawing-a', geometry, properties: { name: 'Drawn polygon' } },
  ] },
};
export function layer(name = 'displacement', reference = true): RasterGroup {
  return { name, uses_spatial_ref: reference, algorithm: reference ? 'shift' : null,
    file_list: [], mask_file_list: [], mask_min_value: 0.5, nodata: null,
    x_values: ['2026-01-01', '2026-01-13', '2026-01-25'],
    latlon_bounds: [10, 45, 10.1, 45.1], available_mask_vars: [] };
}
export function polygonState(): AppState {
  return {
    currentDataset: 'displacement', datasetInfo: { displacement: layer() }, dataMode: 'md',
    layerMasks: [], customMaskPath: null, refEnabled: true, refMarkerPosition: [45.04, 10.04],
    refBufferEnabled: false, refBufferRadius: 50, overlays: [imported, drawn], units: 'metric',
  } as unknown as AppState;
}
export function resultFor(body: PolygonBody): PolygonResult {
  const masks = [
    ...(body.primary_mask ? [{ kind: 'primary', operator: '>=', threshold: body.mask_min_value ?? 0.5 }] : []),
    ...body.layer_masks.map(m => ({ kind: 'layer', layer: m.dataset, operator: m.mode === 'max' ? '<=' : '>=', threshold: m.threshold })),
    ...(body.custom_mask_path ? [{ kind: 'custom', operator: '>', threshold: 0 }] : []),
  ];
  return {
    variable: body.variable, labels: ['2026-01-01', '2026-01-13', '2026-01-25'], units: 'meters',
    statistics: [
      { count: 9, mean: 0, median: 0, percentiles: { '10': 0, '90': 0 } },
      { count: 9, mean: 1, median: 1.25, percentiles: { '10': 0.5, '90': 2 } },
      { count: 0, mean: null, median: null, percentiles: { '10': null, '90': null } },
    ],
    common_pixels: 9, polygon_pixels: 12, support: body.support,
    reference: body.ref_lon !== undefined ? 'interactive' : 'stored', optional_masks_applied: masks.length > 0,
    reference_details: body.ref_lon === undefined ? { applied: false } : {
      applied: true, longitude: body.ref_lon, latitude: body.ref_lat,
      buffer_meters: body.ref_buffer_m ?? 0, method: body.ref_buffer_m ? 'circular_median' : 'nearest_pixel',
      offsets: [0, 1, null],
    },
    masks, component_compatibility: 'unverified', warnings: ['Component compatibility is unverified.'],
  };
}
