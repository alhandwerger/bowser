import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { geometry, polygonState, resultFor } from '../test/polygonFixtures';
import { polygonRequest, type PolygonCall } from '../map/polygonAnalysis';
import { usePolygonSummary } from './usePolygonSummary';

const call = () => polygonRequest(polygonState(), geometry, 'common', 'catalog-a')!;
const response = (request: PolygonCall) => ({ ok: true, json: async () => resultFor(request.body) });
const advance = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(200); }); };

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('polygon request lifecycle', () => {
  it('waits for an explicit request, debounces, and sends the full request to its catalog', async () => {
    const request = call(), fetcher = vi.fn().mockResolvedValue(response(request));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(({ request }: { request: PolygonCall | null }) => usePolygonSummary(request), {
      initialProps: { request: null } as { request: PolygonCall | null },
    });
    await advance();
    expect(fetcher).not.toHaveBeenCalled();
    hook.rerender({ request });
    expect(hook.result.current.loading).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    await advance();
    expect(fetcher).toHaveBeenCalledWith(request.url, expect.objectContaining({
      method: 'POST', body: JSON.stringify(request.body), headers: { 'Content-Type': 'application/json' },
    }));
    expect(hook.result.current.data?.statistics[0].median).toBe(0);
    hook.rerender({ request: structuredClone(request) });
    await advance();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('clears an old chart immediately and ignores a late obsolete response, even without transport cancellation', async () => {
    const first = call(), second = { ...first, body: { ...first.body, ref_lon: 10.05 } };
    let finishOld!: (value: unknown) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(response(second));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(({ request }) => usePolygonSummary(request), { initialProps: { request: first } });
    await advance();
    const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
    hook.rerender({ request: second });
    expect(signal.aborted).toBe(true);
    expect(hook.result.current.data).toBeNull();
    await advance();
    expect(hook.result.current.data?.reference_details?.longitude).toBe(10.05);
    await act(async () => finishOld(response(first)));
    expect(hook.result.current.data?.reference_details?.longitude).toBe(10.05);
  });

  it('hides previously completed values while a changed request loads', async () => {
    const first = call();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(first)));
    const hook = renderHook(({ request }) => usePolygonSummary(request), { initialProps: { request: first } });
    await advance();
    expect(hook.result.current.data).not.toBeNull();
    hook.rerender({ request: { ...first, body: { ...first.body, support: 'per_date' } } });
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.loading).toBe(true);
  });

  it.each([422, 501])('reports HTTP %s explicitly without falling back to unadjusted data', async status => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({ detail: 'Unsupported selection' }) });
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(() => usePolygonSummary(call()));
    await advance();
    expect(hook.result.current.error).toBe('Unsupported selection');
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.data).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('handles a non-JSON error and validation details without a permanent loading state', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false, status: 503, json: async () => { throw new Error(); } })
      .mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ detail: [{ msg: 'Too many pixels' }] }) });
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(({ revision }) => usePolygonSummary(call(), revision), { initialProps: { revision: 0 } });
    await advance();
    expect(hook.result.current.error).toBe('HTTP 503');
    hook.rerender({ revision: 1 });
    await advance();
    expect(hook.result.current.error).toBe('Too many pixels');
  });

  it('cancels pending work on close/unmount and permits an explicit refresh', async () => {
    const request = call(), fetcher = vi.fn().mockResolvedValue(response(request));
    vi.stubGlobal('fetch', fetcher);
    const hook = renderHook(({ request, revision }: { request: PolygonCall | null; revision: number }) => usePolygonSummary(request, revision), {
      initialProps: { request, revision: 0 } as { request: PolygonCall | null; revision: number },
    });
    await advance();
    hook.rerender({ request, revision: 1 });
    await advance();
    expect(fetcher).toHaveBeenCalledTimes(2);
    hook.rerender({ request: null, revision: 1 });
    expect(hook.result.current.data).toBeNull();
    expect(hook.result.current.loading).toBe(false);
    expect((fetcher.mock.calls[1][1].signal as AbortSignal).aborted).toBe(true);
    hook.rerender({ request, revision: 1 });
    hook.unmount();
    await advance();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
