import { useState } from 'react';
import { useAppContext } from '../../context/AppContext';
import { usePolygonSummary } from '../../hooks/usePolygonSummary';
import { polygonChoices, polygonRequest, type PolygonSupport } from '../../map/polygonAnalysis';
import PolygonChart from '../PolygonChart';
import { SectionHeader } from './controls';

/** Analyze imported features and retained drawings with the active layer settings. */
export default function PolygonAnalysis() {
  const { state } = useAppContext();
  const choices = polygonChoices(state.overlays);
  const [selected, setSelected] = useState('');
  const [support, setSupport] = useState<PolygonSupport>('common');
  const [active, setActive] = useState(false);
  const [revision, setRevision] = useState(0);
  const feature = choices.find(choice => choice.key === selected);
  const catalog = new URLSearchParams(window.location.search).get('dataset');
  const request = active && feature ? polygonRequest(state, feature.geometry, support, catalog) : null;
  const summary = usePolygonSummary(request, revision);
  const unavailable = !feature ? 'Select a polygon. A removed or replaced feature must be selected again.'
    : !request ? 'Choose an active raster layer.' : null;
  return (
    <div className="sidebar-section">
      <SectionHeader label="Polygon summary" />
      {!choices.length && <div className="row-label">Import a polygon, or finish one with the drawing tools.</div>}
      <label className="row-label" htmlFor="polygon-feature">Polygon</label>
      <select id="polygon-feature" className="sidebar-select" value={feature ? selected : ''}
        onChange={e => setSelected(e.target.value)}>
        <option value="">Choose a polygon…</option>
        {choices.map(choice => <option key={choice.key} value={choice.key}>{choice.name}</option>)}
      </select>
      <label className="row-label" htmlFor="polygon-support">Pixel selection</label>
      <select id="polygon-support" className="sidebar-select" value={support}
        onChange={e => setSupport(e.target.value as PolygonSupport)}>
        <option value="common">Same pixels at all dates</option>
        <option value="per_date">Available pixels per date</option>
      </select>
      <button type="button" className="hist-btn" style={{ width: '100%' }}
        disabled={!feature || !state.currentDataset || !state.datasetInfo[state.currentDataset]}
        onClick={() => { setActive(true); setRevision(r => r + 1); }}>
        {active ? 'Refresh polygon chart' : 'Plot polygon'}
      </button>
      <div className="row-label">Uses the active layer, spatial reference and masks over the full stored record. Open charts update when those settings change.</div>
      {active && <PolygonChart name={feature?.name ?? 'Polygon unavailable'} request={request}
        data={summary.data} loading={summary.loading} error={unavailable ?? summary.error}
        units={state.units} onClose={() => setActive(false)} />}
    </div>
  );
}
