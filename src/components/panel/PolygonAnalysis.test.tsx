import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useAppContext } from '../../context/AppContext';
import type { AppAction } from '../../types';
import { drawn, geometry, imported, layer, resultFor } from '../../test/polygonFixtures';
import type { PolygonBody } from '../../map/polygonAnalysis';
import PolygonAnalysis from './PolygonAnalysis';
import OverlaysTab from './OverlaysTab';

const chart = vi.hoisted(() => ({ props: null as null | {
  data: { labels: string[]; datasets: Array<{ label: string; data: Array<number | null>; hidden: boolean; spanGaps: boolean }> };
  options: { scales: { x: { type: string } }; plugins: { legend: { onClick: (event: unknown, item: { text: string }) => void } } };
} }));
vi.mock('react-chartjs-2', () => ({ Line: (props: NonNullable<typeof chart.props>) => {
  chart.props = props;
  return <div data-testid="chart"><button onClick={() => props.options.plugins.legend.onClick({}, { text: 'Mean' })}>Mean legend</button></div>;
} }));
vi.mock('../../map/mapChoice', () => ({ browserHasWebGL2: () => false, chooseMap: () => 'leaflet' }));

let dispatch: (action: AppAction) => void;
const advance = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(200); }); };
function Seed({ overlays = false }: { overlays?: boolean }) {
  const context = useAppContext();
  dispatch = context.dispatch;
  useEffect(() => {
    dispatch({ type: 'SET_DATASETS', payload: { displacement: layer(), velocity: layer('velocity') } });
    dispatch({ type: 'SET_CURRENT_DATASET', payload: 'displacement' });
    dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [45.04, 10.04] });
    dispatch({ type: 'SET_OVERLAYS', payload: [imported] });
    dispatch({ type: 'SET_DRAWINGS', payload: drawn.data! });
  }, []);
  return overlays ? <OverlaysTab /> : <PolygonAnalysis />;
}
function start(name = 'Example polygon') {
  const option = screen.getByRole('option', { name: new RegExp(name) }) as HTMLOptionElement;
  fireEvent.change(screen.getByLabelText('Polygon'), { target: { value: option.value } });
  fireEvent.click(screen.getByRole('button', { name: 'Plot polygon' }));
}
function mockFetch() {
  const fetcher = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => ({
    ok: true, json: async () => resultFor(JSON.parse(init.body as string) as PolygonBody),
  }));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
beforeEach(() => { vi.useFakeTimers(); chart.props = null; window.history.replaceState({}, '', '/?dataset=catalog-a'); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState({}, '', '/'); });

describe('polygon chart controls', () => {
  it('is available in the existing Overlays panel and analyzes imported or drawn features only on request', async () => {
    const fetcher = mockFetch();
    render(<AppProvider><Seed overlays /></AppProvider>);
    expect(screen.getByRole('button', { name: 'Plot polygon' }).hasAttribute('disabled')).toBe(true);
    await advance();
    expect(fetcher).not.toHaveBeenCalled();
    start(); await advance();
    expect(fetcher.mock.calls[0][0]).toBe('/polygon_timeseries?dataset=catalog-a');
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.geometry).toEqual(geometry);
    expect(body.support).toBe('common');
    expect(chart.props?.data.datasets[0].data).toEqual([0, 1.25, null]);
    expect(chart.props?.data.datasets[0].spanGaps).toBe(false);
    expect(chart.props?.options.scales.x.type).toBe('time');
    fireEvent.click(screen.getByRole('button', { name: 'Close polygon chart' }));
    start('Drawn polygon'); await advance();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('dialog').textContent).toContain('Drawn polygon');
  });

  it('updates the active reference, buffer, masks, layer and support without retaining stale curves', async () => {
    const fetcher = mockFetch();
    render(<AppProvider><Seed /></AppProvider>);
    start(); await advance();
    act(() => dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [45.05, 10.06] }));
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Calculating');
    await advance();
    expect(JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body).ref_lon).toBe(10.06);
    act(() => {
      dispatch({ type: 'TOGGLE_REF_BUFFER' });
      dispatch({ type: 'SET_REF_BUFFER_RADIUS', payload: 25 });
      dispatch({ type: 'ADD_LAYER_MASK', payload: { id: 'q', dataset: 'quality', threshold: 0.8, mode: 'min' } });
      dispatch({ type: 'SET_CUSTOM_MASK_PATH', payload: '/tmp/custom.tif' });
    });
    fireEvent.change(screen.getByLabelText('Pixel selection'), { target: { value: 'per_date' } });
    await advance();
    expect(JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body)).toMatchObject({
      support: 'per_date', ref_buffer_m: 25, custom_mask_path: '/tmp/custom.tif',
      layer_masks: [{ dataset: 'quality', threshold: 0.8, mode: 'min' }],
    });
    act(() => dispatch({ type: 'SET_CURRENT_DATASET', payload: 'velocity' }));
    await advance();
    expect(JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body).variable).toBe('velocity');
    act(() => dispatch({ type: 'TOGGLE_REF_ENABLED' }));
    await advance();
    expect(JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body).ref_lon).toBeUndefined();
    expect(screen.getByRole('dialog').textContent).toContain('Stored reference');
  });

  it('ignores the date slider and display changes, retaining legend choices across reloads', async () => {
    const fetcher = mockFetch();
    render(<AppProvider><Seed /></AppProvider>);
    start(); await advance();
    fireEvent.click(screen.getByRole('button', { name: 'Mean legend' }));
    expect(chart.props?.data.datasets[1].hidden).toBe(false);
    act(() => {
      dispatch({ type: 'SET_TIME_INDEX', payload: 2 });
      dispatch({ type: 'SET_COLORMAP', payload: 'viridis' });
      dispatch({ type: 'SET_OPACITY', payload: 0.4 });
      dispatch({ type: 'SET_UNITS', payload: 'imperial' });
    });
    await advance();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(chart.props?.data.labels).toHaveLength(3);
    expect(chart.props?.data.datasets[0].data[1]).toBeCloseTo(1.25 * 1000 / 25.4);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh polygon chart' })); await advance();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(chart.props?.data.datasets[1].hidden).toBe(false);
  });

  it('recomputes edited drawings and never silently replaces a deleted selection', async () => {
    const fetcher = mockFetch();
    render(<AppProvider><Seed /></AppProvider>);
    start('Drawn polygon'); await advance();
    const edited = { ...drawn.data!.features[0] as object, geometry: { type: 'MultiPolygon', coordinates: [geometry.coordinates] } };
    act(() => dispatch({ type: 'SET_DRAWINGS', payload: { type: 'FeatureCollection', features: [edited] } }));
    await advance();
    expect(JSON.parse(fetcher.mock.calls[fetcher.mock.calls.length - 1][1].body).geometry.type).toBe('MultiPolygon');
    act(() => dispatch({ type: 'SET_DRAWINGS', payload: { type: 'FeatureCollection', features: [] } }));
    await advance();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert').textContent).toContain('Select a polygon');
    expect(screen.queryByTestId('chart')).toBeNull();
  });

  it('displays server rejection and no-data responses without substituting unmasked values', async () => {
    const fetcher = mockFetch();
    fetcher.mockImplementationOnce(async () => ({ ok: false, status: 422, json: async () => ({ detail: 'Mask dates do not match' }) }));
    render(<AppProvider><Seed /></AppProvider>);
    start(); await advance();
    expect(screen.getByRole('alert').textContent).toBe('Mask dates do not match');
    expect(screen.queryByRole('button', { name: 'CSV (native units)' })).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      const data = resultFor(JSON.parse(init.body as string));
      data.common_pixels = 0;
      data.statistics = data.statistics.map(() => ({ count: 0, mean: null, median: null, percentiles: { '10': null, '90': null } }));
      data.labels = ['pair-a', 'pair-b', 'pair-c'];
      return { ok: true, json: async () => data };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh polygon chart' })); await advance();
    expect(screen.getByRole('status').textContent).toContain('No usable');
    expect(chart.props?.data.datasets[0].data).toEqual([null, null, null]);
    expect(chart.props?.options.scales.x.type).toBe('category');
  });

  it('isolates chart interactions from map clicks and exports native values/details', async () => {
    const fetcher = mockFetch(), mapClick = vi.fn(), nativeClick = vi.fn();
    const view = render(<AppProvider><div data-testid="map" onClick={mapClick}><Seed /></div></AppProvider>);
    screen.getByTestId('map').addEventListener('click', nativeClick);
    start(); await advance();
    mapClick.mockClear(); nativeClick.mockClear();
    expect(screen.getByRole('dialog').parentElement).toBe(document.body);
    expect(view.container.contains(screen.getByRole('dialog'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Mean legend' }));
    const create = vi.fn().mockReturnValue('blob:example'), revoke = vi.fn();
    class TestURL extends URL { static createObjectURL = create; static revokeObjectURL = revoke; }
    vi.stubGlobal('URL', TestURL);
    const links: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { links.push(this); });
    fireEvent.click(screen.getByRole('button', { name: 'CSV (native units)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Values and details (JSON)' }));
    expect(links.map(link => link.download)).toEqual([
      'Imported-features-Example-polygon_displacement_summary.csv',
      'Imported-features-Example-polygon_displacement_summary.json',
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    expect(mapClick).not.toHaveBeenCalled(); expect(nativeClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close polygon chart' }));
    act(() => dispatch({ type: 'SET_REF_MARKER_POSITION', payload: [45.05, 10.05] }));
    await advance();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
