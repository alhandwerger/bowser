import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState, MultiPointTimeSeriesData } from '../types';
import { polygonState } from '../test/polygonFixtures';
import { DEFAULT_FIT } from '../map/fitSettings';
import TimeSeriesChart from './TimeSeriesChart';
import RefPointChart from './RefPointChart';

let state: AppState;
const api = vi.hoisted(() => ({ fetchMultiPointTimeSeries: vi.fn(), fetchBufferTimeSeries: vi.fn() }));
const dispatch = vi.hoisted(() => vi.fn());
vi.mock('../context/AppContext', () => ({ useAppContext: () => ({ state, dispatch }) }));
vi.mock('../hooks/useApi', () => ({ useApi: () => api }));
vi.mock('react-chartjs-2', async () => {
  const { forwardRef } = await import('react');
  return { Line: forwardRef((_props: { data: unknown }, ref) => { void ref; return <pre data-testid="chart">{JSON.stringify(_props.data)}</pre>; }) };
});

const dates = ['2026-01-01', '2026-01-13', '2026-01-25'];
function pointData(value = 2): MultiPointTimeSeriesData {
  return { labels: dates, datasets: [{ pointId: 'a', label: 'a', borderColor: '#f00', backgroundColor: '#f002', data: dates.map((x, i) => ({ x, y: i * value })) }] };
}
function chartData() { return JSON.parse(screen.getByTestId('chart').textContent!); }

beforeEach(() => {
  state = { ...polygonState(), showChart: true, chartWindows: [{ id: 'one', dataset: null }],
    timeSeriesPoints: [{ id: 'a', position: [0, 3], name: 'a', color: '#f00', visible: true }],
    bufferEnabled: true, bufferRadius: 20, bufferSamples: 2, fitSettings: DEFAULT_FIT,
    showTrends: false, showResiduals: false, showRefChart: true, refBufferEnabled: true,
    units: 'metric', dateRangeStart: null, dateRangeEnd: null,
  } as unknown as AppState;
  api.fetchMultiPointTimeSeries.mockReset().mockResolvedValue(pointData());
  api.fetchBufferTimeSeries.mockReset().mockResolvedValue({ labels: dates, median: dates.map((x, i) => ({ x, y: i })), samples: [], n_pixels: 2 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('chart mask lifecycle', () => {
  it('refreshes point and radius requests for uploaded masks and reference radii', async () => {
    const { rerender } = render(<TimeSeriesChart windowId="one" />);
    await screen.findByTestId('chart');
    state = { ...state, customMaskPath: '/tmp/mask.tif', refBufferRadius: 17 };
    rerender(<TimeSeriesChart windowId="one" />);
    await waitFor(() => expect(api.fetchMultiPointTimeSeries.mock.lastCall?.[7]).toEqual({ custom_mask_path: '/tmp/mask.tif' }));
    expect(api.fetchMultiPointTimeSeries.mock.lastCall?.[6]).toBe(17);
    await waitFor(() => expect(api.fetchBufferTimeSeries.mock.lastCall?.[9]).toEqual({ custom_mask_path: '/tmp/mask.tif' }));
    expect(api.fetchBufferTimeSeries.mock.lastCall?.[8]).toBe(17);
  });

  it('clears failed results and ignores older point requests after a mask changes', async () => {
    let complete!: (value: MultiPointTimeSeriesData) => void;
    api.fetchMultiPointTimeSeries.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { rerender } = render(<TimeSeriesChart windowId="one" />);
    state = { ...state, customMaskPath: '/tmp/mask.tif' };
    api.fetchMultiPointTimeSeries.mockResolvedValueOnce(undefined);
    rerender(<TimeSeriesChart windowId="one" />);
    await screen.findByRole('alert');
    expect(screen.queryByTestId('chart')).toBeNull();
    await act(async () => { complete(pointData(999)); });
    expect(screen.queryByTestId('chart')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Could not load');
  });

  it('honors reference-preview masks and retains missing dates in their proper positions', async () => {
    state = { ...state, dataMode: 'cog', customMaskPath: '/tmp/mask.tif' };
    state.datasetInfo.displacement.mask_file_list = ['primary.tif'];
    api.fetchBufferTimeSeries.mockResolvedValue({ labels: dates, median: [{ x: dates[0], y: 0 }, { x: dates[2], y: 4 }], samples: [[{ x: dates[0], y: 0 }, { x: dates[2], y: 4 }]], n_pixels: 1 });
    render(<RefPointChart />);
    await screen.findByTestId('chart');
    expect(api.fetchBufferTimeSeries.mock.lastCall?.[9]).toEqual({ primary_mask: true, mask_min_value: .5, custom_mask_path: '/tmp/mask.tif' });
    const data = chartData().datasets;
    expect(data.find((d: { label: string }) => d.label === 'Median').data).toEqual([0, null, 4]);
    expect(data.find((d: { label: string }) => d.label === 'Mean').data).toEqual([0, null, 4]);
  });

  it('removes a previously displayed reference preview when a new mask fails', async () => {
    const { rerender } = render(<RefPointChart />);
    await screen.findByTestId('chart');
    api.fetchBufferTimeSeries.mockResolvedValue(undefined);
    state = { ...state, customMaskPath: '/tmp/absent.tif' };
    rerender(<RefPointChart />);
    await screen.findByRole('alert');
    expect(screen.queryByTestId('chart')).toBeNull();
  });
});
