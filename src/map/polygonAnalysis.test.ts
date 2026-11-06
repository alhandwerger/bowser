import { describe, expect, it } from 'vitest';
import { drawn, geometry, imported, layer, polygonState, resultFor } from '../test/polygonFixtures';
import { polygonChoices, polygonCsv, polygonDetails, polygonRequest, polygonResponse } from './polygonAnalysis';
import { parseKml } from './fileParsers';

describe('polygon features and requests', () => {
  it('uses actual imported and drawn polygons, retaining zero IDs and geometry', () => {
    const choices = polygonChoices([imported, drawn]);
    expect(choices.map(c => c.name)).toEqual(['Imported features — Example polygon', 'Drawings — Drawn polygon']);
    expect(choices[0].geometry.coordinates).toEqual(geometry.coordinates);
    expect(choices[0].key).toContain('number');
  });

  it('keeps KML holes and uses 2D coordinates without altering imported altitudes', () => {
    const kml = '<kml><Placemark><name>Region</name><Polygon><outerBoundaryIs><LinearRing><coordinates>10,45,0 11,45,0 11,46,0 10,46,0 10,45,0</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>10.2,45.2 10.8,45.2 10.8,45.8 10.2,45.8 10.2,45.2</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark></kml>';
    const data = parseKml(kml);
    const choice = polygonChoices([{ ...imported, data }])[0];
    expect(choice.geometry.coordinates).toHaveLength(2);
    expect((choice.geometry.coordinates[0] as number[][])[0]).toEqual([10, 45]);
    expect(((data.features[0].geometry!.coordinates as number[][][])[0])[0]).toEqual([10, 45, 0]);
    expect(polygonRequest(polygonState(), choice.geometry, 'common', null)?.body.geometry).toEqual(choice.geometry);
  });

  it('keeps unique drawing IDs stable through edits and reordering', () => {
    const first = polygonChoices([drawn])[0];
    const feature = drawn.data!.features[0] as object;
    const edited = { ...drawn, data: { type: 'FeatureCollection' as const, features: [
      { ...feature, geometry: { type: 'MultiPolygon', coordinates: [geometry.coordinates] } },
    ] } };
    expect(polygonChoices([edited])[0].key).toBe(first.key);
    expect(polygonChoices([edited])[0].geometry.type).toBe('MultiPolygon');
  });

  it('does not rebind anonymous or duplicate-ID features by array index', () => {
    const a = { geometry, properties: { name: 'A' } }, b = { geometry, properties: { name: 'B' } };
    const overlay = { ...imported, data: { type: 'FeatureCollection' as const, features: [a, b] } };
    const before = polygonChoices([overlay]);
    const after = polygonChoices([{ ...overlay, data: { ...overlay.data, features: [b] } }]);
    expect(after[0].key).toBe(before[1].key);
    expect(after[0].key).not.toBe(before[0].key);
    const duplicates = polygonChoices([{ ...overlay, data: { ...overlay.data, features: [{ ...a, id: 1 }, { ...b, id: 1 }] } }]);
    expect(duplicates[0].key).not.toBe(duplicates[1].key);
  });

  it('forwards eligible references, masks, catalog routing, and explicit buffers', () => {
    const state = polygonState();
    state.layerMasks = [{ id: 'quality', dataset: 'coherence', threshold: 0.8, mode: 'max' }];
    state.customMaskPath = '/tmp/mask.tif';
    state.refBufferEnabled = true;
    const call = polygonRequest(state, geometry, 'per_date', 'area-a')!;
    expect(call.url).toBe('/polygon_timeseries?dataset=area-a');
    expect(call.body).toEqual({ variable: 'displacement', geometry, support: 'per_date', percentiles: [10, 90],
      layer_masks: [{ dataset: 'coherence', threshold: 0.8, mode: 'max' }], custom_mask_path: '/tmp/mask.tif',
      ref_lat: 45.04, ref_lon: 10.04, ref_buffer_m: 50 });
  });

  it('forwards configured GeoTIFF primary masks for the full record', () => {
    const state = polygonState(); state.dataMode = 'cog';
    state.datasetInfo.displacement.mask_file_list = ['primary.tif'];
    const call = polygonRequest(state, geometry, 'common', null)!;
    expect(call.body.primary_mask).toBe(true);
    expect(call.body.mask_min_value).toBe(0.5);
  });

  it('omits ineligible/disabled references and waits for layer metadata', () => {
    const state = polygonState();
    state.refEnabled = false;
    expect(polygonRequest(state, geometry, 'common', null)?.body.ref_lon).toBeUndefined();
    state.refEnabled = true; state.datasetInfo.displacement = layer('displacement', false);
    expect(polygonRequest(state, geometry, 'common', null)?.body.ref_lon).toBeUndefined();
    state.currentDataset = 'missing';
    expect(polygonRequest(state, geometry, 'common', null)).toBeNull();
  });

  it('does not change a full-record request for time, color, opacity, or display units', () => {
    const state = polygonState(), first = polygonRequest(state, geometry, 'common', null);
    Object.assign(state, { currentTimeIndex: 5, colormap: 'viridis', opacity: 0.2, units: 'imperial' });
    expect(polygonRequest(state, geometry, 'common', null)).toEqual(first);
  });
});

describe('response and export correctness', () => {
  it('preserves real zeros and missing values', () => {
    const body = polygonRequest(polygonState(), geometry, 'common', null)!.body;
    const result = resultFor(body);
    expect(polygonResponse(result, body)).toBe(result);
    expect(result.statistics[0].median).toBe(0);
    expect(result.statistics[2].median).toBeNull();
  });

  it.each(['layer', 'reference', 'masks', 'position', 'statistics'])('rejects a mismatched %s response', kind => {
    const body = polygonRequest(polygonState(), geometry, 'common', null)!.body;
    const result = resultFor(body);
    if (kind === 'layer') result.variable = 'wrong';
    if (kind === 'reference') result.reference = 'stored';
    if (kind === 'masks') result.optional_masks_applied = true;
    if (kind === 'position') result.reference_details!.longitude = 0;
    if (kind === 'statistics') result.statistics.pop();
    expect(() => polygonResponse(result, body)).toThrow();
  });

  it('exports native CSV values without converting missing values to zero or evaluating labels', () => {
    const body = polygonRequest(polygonState(), geometry, 'common', null)!.body;
    const result = resultFor(body);
    result.labels[1] = '=1+1'; result.statistics[1].mean = -1;
    const csv = polygonCsv(result);
    expect(csv.split('\n')[1]).toBe('"2026-01-01","displacement","meters","9","0","0","0","0"');
    expect(csv).toContain('"\'=1+1"');
    expect(csv).toContain('"-1"');
    expect(csv.split('\n')[3]).toContain('"0",,,,');
  });

  it('exports reference/mask details without a server directory path', () => {
    const state = polygonState(); state.customMaskPath = '/private/tmp/mask.tif';
    const call = polygonRequest(state, geometry, 'common', 'area')!;
    const details = polygonDetails(resultFor(call.body), call, 'Region');
    expect(details).not.toContain('/private/tmp');
    expect(JSON.parse(details).parameters.custom_mask_file).toBe('mask.tif');
    expect(JSON.parse(details).result.reference_details.longitude).toBe(10.04);
    expect(call.body.custom_mask_path).toBe('/private/tmp/mask.tif');
  });
});
