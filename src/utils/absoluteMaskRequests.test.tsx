import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { polygonState } from '../test/polygonFixtures';
import { buildTileRequest } from './tileParams';
import { polygonRequest } from '../map/polygonAnalysis';
import { useApi } from '../hooks/useApi';
import type { AppState, LayerMaskMode } from '../types';
import ExportSection from '../components/panel/ExportSection';

let state: AppState;
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state }) }));
beforeEach(() => {
  state = { ...polygonState(), currentTimeIndex: 0, complexMode: 'phase', wrapEnabled: false, refEnabled: false, refValues: {} } as AppState;
  window.history.replaceState({}, '', '/?dataset=example');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

describe('absolute modes survive map, chart, polygon and export requests', () => {
  it.each(['abs_min', 'abs_max'] as LayerMaskMode[])('keeps %s and its threshold intact', async mode => {
    state.layerMasks = [{ id: 'm', dataset: 'factor', mode, threshold: 5 }];
    const mask = { dataset: 'factor', mode, threshold: 5 };
    const tile = buildTileRequest({ dataset: 'displacement', dsInfo: state.datasetInfo.displacement, timeIndex: 0,
      vmin: -1, vmax: 1, colormap: 'rdbu', state, datasetId: 'example' });
    expect(JSON.parse(tile.params.layer_masks)).toEqual([mask]);
    const geometry = { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
    expect(polygonRequest(state, geometry, 'common', 'example')!.body.layer_masks).toEqual([mask]);
    const { result } = renderHook(() => useApi());
    await result.current.fetchMultiPointTimeSeries([], 'displacement', undefined, undefined, false, state.layerMasks);
    await result.current.fetchBufferTimeSeries(3, 0, 'displacement', 10, 0, undefined, undefined, state.layerMasks);
    for (const [, init] of vi.mocked(fetch).mock.calls) expect(JSON.parse(init!.body as string).layer_masks).toEqual([mask]);
    render(<ExportSection />);
    fireEvent.click(screen.getByText('Data layer (GeoTIFF)'));
    await waitFor(() => expect(screen.queryByText('Exporting…')).toBeNull());
    const url = String(vi.mocked(fetch).mock.lastCall![0]);
    expect(JSON.parse(new URL(url, location.origin).searchParams.get('layer_masks')!)).toEqual([mask]);
  });
});
