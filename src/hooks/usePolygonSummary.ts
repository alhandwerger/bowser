import { useEffect, useState } from 'react';
import { polygonResponse, type PolygonCall, type PolygonResult } from '../map/polygonAnalysis';

interface SummaryState { key: string | null; data: PolygonResult | null; loading: boolean; error: string | null }

/** Debounce changes, cancel obsolete fetches, and never show a previous request's data. */
export function usePolygonSummary(request: PolygonCall | null, revision = 0) {
  const key = request ? JSON.stringify([request, revision]) : null;
  const [result, setResult] = useState<SummaryState>({ key: null, data: null, loading: false, error: null });
  useEffect(() => {
    if (key === null) return;
    const [call] = JSON.parse(key) as [PolygonCall, number];
    let active = true;
    const controller = new AbortController();
    setResult({ key, data: null, loading: true, error: null });
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(call.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(call.body), signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) {
          const detail = typeof body?.detail === 'string' ? body.detail : Array.isArray(body?.detail)
            ? body.detail.map((e: { msg?: string }) => e.msg ?? 'Invalid option').join('; ') : `HTTP ${response.status}`;
          throw new Error(detail);
        }
        const data = polygonResponse(body, call.body);
        if (active) setResult({ key, data, loading: false, error: null });
      } catch (error) {
        if (active) setResult({ key, data: null, loading: false, error: error instanceof Error ? error.message : 'Polygon summary request failed.' });
      }
    }, 200);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [key]);
  return result.key === key ? result : { key, data: null, loading: key !== null, error: null };
}
