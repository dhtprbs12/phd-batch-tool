import React, { useState } from 'react';
import UploadStep from './components/UploadStep';
import ReviewStep from './components/ReviewStep';

export interface ProductSet {
  id: string;
  status: string;
  images: { front: string; ingredients: string; barcode: string | null };
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
}

type AppStep = 'upload' | 'review';

export default function App() {
  const [step, setStep] = useState<AppStep>('upload');
  const [queue, setQueue] = useState<ProductSet[]>([]);
  const [savedCount, setSavedCount] = useState(0);

  const handleProcessed = (results: ProductSet[]) => {
    setQueue(results);
    setStep('review');
  };

  const handleSaved = () => {
    setSavedCount(c => c + 1);
  };

  const handleDone = () => {
    setQueue([]);
    setStep('upload');
  };

  return (
    <div style={{ minHeight: '100vh', padding: '24px 32px' }}>
      <header style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>PHD Batch Import</h1>
        {savedCount > 0 && (
          <span style={{ fontSize: 14, color: '#5C6B66', background: '#e8f5e9', padding: '4px 12px', borderRadius: 12 }}>
            {savedCount} products saved
          </span>
        )}
      </header>

      {step === 'upload' && <UploadStep onProcessed={handleProcessed} />}
      {step === 'review' && (
        <ReviewStep queue={queue} onSaved={handleSaved} onDone={handleDone} />
      )}
    </div>
  );
}
