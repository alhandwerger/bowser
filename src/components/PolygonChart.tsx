import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Line } from 'react-chartjs-2';
import { CategoryScale, Chart as ChartJS, Legend, LinearScale, LineElement, PointElement, TimeScale, Tooltip } from 'chart.js';
import 'chartjs-adapter-date-fns';
import { useDraggableResizable } from '../hooks/useDraggableResizable';
import { displayUnit, type UnitSystem } from '../utils/units';
import { polygonCsv, polygonDetails, type PolygonCall, type PolygonResult } from '../map/polygonAnalysis';

ChartJS.register(CategoryScale, TimeScale, LinearScale, PointElement, LineElement, Tooltip, Legend);

interface Props {
  name: string; request: PolygonCall | null; data: PolygonResult | null;
  loading: boolean; error: string | null; units: UnitSystem; onClose: () => void;
}

function download(content: string, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** A viewport portal keeps map-native listeners away from chart/legend clicks. */
export default function PolygonChart({ name, request, data, loading, error, units, onClose }: Props) {
  const [visible, setVisible] = useState({ Median: true, Mean: false, P10: true, P90: true });
  const { panelRef, panelStyle, onDragMouseDown, resizeGrip } = useDraggableResizable({
    defaultWidth: Math.min(700, window.innerWidth - 32), defaultHeight: Math.min(470, window.innerHeight - 32),
    initialRight: 24, initialBottom: 24,
  });
  const unit = displayUnit(data?.units ?? undefined, units);
  const dated = !!data?.labels.every(label => /^\d{4}-\d{2}-\d{2}(?:T[0-9:.+Z-]+)?$/.test(label) && Number.isFinite(Date.parse(label)));
  const color = (property: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(property).trim() || fallback;
  const text = color('--sb-text', '#222');
  const border = color('--sb-border', '#ddd');
  const count = data?.statistics.map(s => s.count) ?? [];
  const basename = `${name}_${data?.variable ?? 'polygon'}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[._-]+/, '').slice(0, 100) || 'polygon';
  const series = data ? [
    { label: 'Median', values: data.statistics.map(s => s.median), color: '#20a69b', dash: [] },
    { label: 'Mean', values: data.statistics.map(s => s.mean), color: '#e69538', dash: [] },
    { label: 'P10', values: data.statistics.map(s => s.percentiles['10']), color: '#9674d0', dash: [5, 4] },
    { label: 'P90', values: data.statistics.map(s => s.percentiles['90']), color: '#9674d0', dash: [5, 4] },
  ] : [];
  return createPortal(
    <div ref={panelRef} className="polygon-chart-window" style={panelStyle} role="dialog" aria-label="Polygon summary"
      onMouseDown={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
      <div className="chart-header" onMouseDown={onDragMouseDown}>
        <strong>{name}</strong>
        <button type="button" className="chart-btn" onClick={onClose} aria-label="Close polygon chart">×</button>
      </div>
      {loading && <div role="status">Calculating polygon summary…</div>}
      {error && <div role="alert">{error}</div>}
      {data && <>
        <div className="polygon-summary-caption">
          <b>{data.variable}</b> · full stored record · {data.reference === 'interactive' ? 'Selected spatial reference' : 'Stored reference'}
          {' · '}{data.masks.length} optional masks
          {' · '}{data.support === 'common' ? 'Same pixels at all dates' : 'Available pixels per date'}
          <br />Eligible common pixels: {data.common_pixels}/{data.polygon_pixels}; usable per date: {Math.min(...count)}–{Math.max(...count)}.
        </div>
        {!count.some(n => n > 0) && <div role="status">No usable measurements for this selection.</div>}
        <div className="polygon-chart-canvas">
          <Line data={{ labels: data.labels, datasets: series.map(s => ({
            label: s.label, data: s.values.map(v => v === null ? null : v * unit.factor),
            borderColor: s.color, backgroundColor: s.color, borderWidth: s.label === 'Median' ? 2 : 1,
            borderDash: s.dash, hidden: !visible[s.label as keyof typeof visible], pointRadius: 2, spanGaps: false,
          })) }} options={{
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: {
              x: { type: dated ? 'time' : 'category', ticks: { color: text, maxTicksLimit: 8 }, grid: { color: border } },
              y: { title: { display: true, text: unit.label || 'Source units unknown', color: text }, ticks: { color: text }, grid: { color: border } },
            },
            plugins: { legend: { labels: { color: text }, onClick: (_event, item) => {
              if (item.text in visible) setVisible(v => ({ ...v, [item.text]: !v[item.text as keyof typeof v] }));
            } } },
          }} />
        </div>
        <div className="polygon-summary-caption">P10–P90 describes differences between pixels, not a confidence interval. Click a legend entry to show or hide its curve.</div>
        <div className="polygon-summary-actions">
          <button type="button" className="chart-btn" title="Summary values in native source units" onClick={() => download(polygonCsv(data), `${basename}_summary.csv`, 'text/csv')}>CSV (native units)</button>
          <button type="button" className="chart-btn" onClick={() => download(polygonDetails(data, request, name), `${basename}_summary.json`, 'application/json')}>Values and details (JSON)</button>
        </div>
        <details className="polygon-summary-caption">
          <summary>Support and reference details</summary>
          {data.warnings.map((warning, index) => <div key={index}>{warning}</div>)}
          <div>Source units: {data.units ?? 'unknown'}. Connected-component compatibility: {data.component_compatibility}.</div>
          <div>Reference method: {data.reference_details?.method ?? data.reference}.</div>
          {data.reference === 'interactive' && <div>Reference (longitude, latitude): {data.reference_details?.longitude}, {data.reference_details?.latitude}; radius: {data.reference_details?.buffer_meters} meters.</div>}
          {data.masks.map((mask, index) => <div key={index}>{mask.layer ?? mask.kind}: {mask.operator} {mask.threshold} (source units)</div>)}
        </details>
      </>}
      {resizeGrip}
    </div>, document.body,
  );
}
