import { useEffect, useState, type CSSProperties } from 'react';
import UploadStep from './components/UploadStep';
import ReviewStep from './components/ReviewStep';
import RequestsStep from './components/RequestsStep';

export interface ProductSet {
  id: string;
  status: string;
  lookupId?: string;
  entry?: 'name' | 'photo';
  sourceUrl?: string | null;
  warning?: string;
  images: { front: string | null; ingredients: string | null; barcode: string | null };
  extracted: {
    manufacturer: string | null;
    brand: string | null;
    lineName: string | null;
    productName: string | null;
    lifeStage: string;
    primaryProteins: string[];
    petType: string;
    productType: string;
    texture: string | null;
    breedSize: string;
    dietTags: string[];
  };
  ingredients: string[];
  rawIngredientsText: string;
  barcode: string | null;
  extraBarcodes?: string[];
}

type WorkMode = 'import' | 'requests';

export default function App() {
  const [mode, setMode] = useState<WorkMode>('import');
  const [reviewing, setReviewing] = useState(false);
  const [queue, setQueue] = useState<ProductSet[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [requestTotal, setRequestTotal] = useState<number | null>(null);

  useEffect(() => {
    if (reviewing) return;
    fetch('/api/batch/requests')
      .then((res) => res.json())
      .then((data) => setRequestTotal(typeof data.total === 'number' ? data.total : null))
      .catch(() => {});
  }, [reviewing, mode]);

  const handleProcessed = (results: ProductSet[]) => {
    setQueue(results);
    setReviewing(true);
  };

  const handleDone = () => {
    setQueue([]);
    setReviewing(false);
  };

  const modeBtn = (active: boolean): CSSProperties => ({
    background: active ? '#2e7d56' : '#fff',
    color: active ? '#fff' : '#1B2B27',
    border: active ? '1px solid #2e7d56' : '1px solid #ccc',
    borderRadius: 10,
    padding: '8px 12px',
    cursor: 'pointer',
    fontWeight: 600,
  });

  return (
    <div style={{ minHeight: '100vh', padding: '24px 32px' }}>
      <header style={{ marginBottom: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>PHD Batch Import</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {savedCount > 0 && (
            <span style={{ fontSize: 14, color: '#5C6B66', background: '#e8f5e9', padding: '4px 12px', borderRadius: 12 }}>
              {savedCount} products saved
            </span>
          )}
          {!reviewing && (
            <>
              <button type="button" onClick={() => setMode('import')} style={modeBtn(mode === 'import')}>Import photos</button>
              <button type="button" onClick={() => setMode('requests')} style={modeBtn(mode === 'requests')}>
                Requests{requestTotal != null ? ` ${requestTotal}` : ''}
              </button>
            </>
          )}
        </div>
      </header>

      {!reviewing && mode === 'import' && <UploadStep onProcessed={handleProcessed} />}
      {!reviewing && mode === 'requests' && (
        <RequestsStep onProcessed={handleProcessed} onTotal={setRequestTotal} />
      )}
      {reviewing && (
        <ReviewStep queue={queue} onSaved={() => setSavedCount(c => c + 1)} onDone={handleDone} />
      )}
    </div>
  );
}
