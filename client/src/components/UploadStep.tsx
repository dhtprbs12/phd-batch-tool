import React, { useCallback, useRef, useState } from 'react';
import type { ProductSet } from '../App';

interface Props {
  onProcessed: (results: ProductSet[]) => void;
}

interface FileGroup {
  front: File;
  ingredients: File;
  barcode: File | null;
}

export default function UploadStep({ onProcessed }: Props) {
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length < 2) return;

    // Auto-group: every 3 photos = 1 product (front, ingredients, barcode)
    const newGroups: FileGroup[] = [];
    for (let i = 0; i < files.length; i += 3) {
      const front = files[i];
      const ingredients = files[i + 1];
      const barcode = files[i + 2] || null;
      if (front && ingredients) {
        newGroups.push({ front, ingredients, barcode });
      }
    }
    setGroups(newGroups);
  };

  const removeGroup = (idx: number) => {
    setGroups(g => g.filter((_, i) => i !== idx));
  };

  const handleSubmit = async () => {
    if (groups.length === 0) return;

    setProcessing(true);
    const results: ProductSet[] = [];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      setProgress(`Processing ${i + 1} / ${groups.length}...`);

      const formData = new FormData();
      formData.append('front', g.front);
      formData.append('ingredients', g.ingredients);
      if (g.barcode) formData.append('barcode', g.barcode);

      try {
        const res = await fetch('/api/batch/process', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.id) results.push(data);
      } catch (e) {
        console.error(`Failed to process set ${i + 1}:`, e);
      }
    }

    setProcessing(false);
    setProgress('');
    if (results.length > 0) onProcessed(results);
  };

  return (
    <div>
      <p style={{ color: '#5C6B66', marginBottom: 16 }}>
        Select all photos at once. Order: <strong>front label, ingredients, barcode</strong> (repeating).
        Every 3 photos = 1 product.
      </p>

      {/* File picker */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFilesSelected}
      />
      <button onClick={() => fileInputRef.current?.click()} style={styles.selectBtn}>
        Select Photos
      </button>

      {/* Preview groups */}
      {groups.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <p style={{ fontSize: 14, color: '#5C6B66', marginBottom: 12 }}>
            {groups.length} product{groups.length !== 1 ? 's' : ''} detected
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {groups.map((group, idx) => (
              <div key={idx} style={styles.groupCard}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <strong style={{ fontSize: 13 }}>Product {idx + 1}</strong>
                  <button onClick={() => removeGroup(idx)} style={styles.removeBtn}>Remove</button>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Thumb file={group.front} label="Front" />
                  <Thumb file={group.ingredients} label="Ingredients" />
                  {group.barcode ? <Thumb file={group.barcode} label="Barcode" /> : (
                    <div style={styles.noBarcode}>No barcode</div>
                  )}
                </div>
              </div>
            ))}
          </div>

          <button
            onClick={handleSubmit}
            disabled={processing}
            style={{ ...styles.submitBtn, marginTop: 16, opacity: processing ? 0.6 : 1 }}
          >
            {processing ? progress : `Process ${groups.length} Product${groups.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      )}
    </div>
  );
}

function Thumb({ file, label }: { file: File; label: string }) {
  return (
    <div style={styles.thumb}>
      <img src={URL.createObjectURL(file)} style={{ width: 70, height: 70, objectFit: 'cover', borderRadius: 6 }} />
      <span style={{ fontSize: 10, color: '#888', marginTop: 2 }}>{label}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  selectBtn: {
    background: '#2e7d56',
    color: '#fff',
    border: 'none',
    padding: '12px 28px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 15,
  },
  groupCard: {
    background: '#fff',
    borderRadius: 10,
    padding: 12,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  },
  thumb: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  noBarcode: {
    width: 70,
    height: 70,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#f5f5f5',
    borderRadius: 6,
    fontSize: 10,
    color: '#aaa',
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: '#e53935',
    fontSize: 12,
    cursor: 'pointer',
  },
  submitBtn: {
    background: '#2e7d56',
    border: 'none',
    color: '#fff',
    padding: '12px 24px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
};
