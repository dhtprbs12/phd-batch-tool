import React, { useCallback, useRef, useState } from 'react';
import heic2any from 'heic2any';
import type { ProductSet } from '../App';

interface Props {
  onProcessed: (results: ProductSet[]) => void;
}

interface FileGroup {
  front: File;
  ingredients: File;
  barcode: File | null;
  extraBarcodes: File[];
}

export default function UploadStep({ onProcessed }: Props) {
  const [groups, setGroups] = useState<FileGroup[]>([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const [barcodeTargetIdx, setBarcodeTargetIdx] = useState<number>(-1);

  const convertIfHeic = async (file: File): Promise<File> => {
    const name = file.name.toLowerCase();
    if (name.endsWith('.heic') || name.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif') {
      try {
        const blob = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 }) as Blob;
        return new File([blob], file.name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg'), { type: 'image/jpeg' });
      } catch (e) {
        console.warn('HEIC conversion failed, using original:', e);
      }
    }
    return file;
  };

  const handleFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawFiles = Array.from(e.target.files || []);
    if (rawFiles.length < 2) return;
    e.target.value = '';

    const files = await Promise.all(rawFiles.map(f => convertIfHeic(f)));

    // Auto-group: every 3 photos = 1 product (front, ingredients, barcode)
    const newGroups: FileGroup[] = [];
    for (let i = 0; i < files.length; i += 3) {
      const front = files[i];
      const ingredients = files[i + 1];
      const barcode = files[i + 2] || null;
      if (front && ingredients) {
        newGroups.push({ front, ingredients, barcode, extraBarcodes: [] });
      }
    }
    setGroups(g => [...g, ...newGroups]);
  };

  const removeGroup = (idx: number) => {
    setGroups(g => g.filter((_, i) => i !== idx));
  };

  const addBarcodeToGroup = (idx: number) => {
    setBarcodeTargetIdx(idx);
    barcodeInputRef.current?.click();
  };

  const handleBarcodeFilesSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawFiles = Array.from(e.target.files || []);
    if (rawFiles.length === 0 || barcodeTargetIdx < 0) return;
    e.target.value = '';
    const files = await Promise.all(rawFiles.map(f => convertIfHeic(f)));
    setGroups(g => g.map((group, i) =>
      i === barcodeTargetIdx
        ? { ...group, extraBarcodes: [...group.extraBarcodes, ...files] }
        : group
    ));
  };

  const removeExtraBarcode = (groupIdx: number, barcodeIdx: number) => {
    setGroups(g => g.map((group, i) =>
      i === groupIdx
        ? { ...group, extraBarcodes: group.extraBarcodes.filter((_, j) => j !== barcodeIdx) }
        : group
    ));
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
      g.extraBarcodes.forEach(f => formData.append('extraBarcodes', f));

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

      {/* File pickers */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleFilesSelected}
      />
      <input
        ref={barcodeInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleBarcodeFilesSelected}
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
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => addBarcodeToGroup(idx)} style={styles.addBarcodeBtn}>+ Barcode</button>
                    <button onClick={() => removeGroup(idx)} style={styles.removeBtn}>Remove</button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Thumb file={group.front} label="Front" />
                  <Thumb file={group.ingredients} label="Ingredients" />
                  {group.barcode ? <Thumb file={group.barcode} label="Barcode" /> : (
                    <div style={styles.noBarcode}>No barcode</div>
                  )}
                  {group.extraBarcodes.map((f, bi) => (
                    <div key={bi} style={{ position: 'relative' }}>
                      <Thumb file={f} label={`+Barcode ${bi + 1}`} />
                      <button
                        onClick={() => removeExtraBarcode(idx, bi)}
                        style={styles.extraBarcodeRemove}
                      >×</button>
                    </div>
                  ))}
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
      <span style={{ fontSize: 9, color: '#bbb', marginTop: 1, maxWidth: 70, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
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
  addBarcodeBtn: {
    background: 'none',
    border: '1px solid #2e7d56',
    color: '#2e7d56',
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 4,
    cursor: 'pointer',
    fontWeight: 600,
  },
  extraBarcodeRemove: {
    position: 'absolute' as const,
    top: -4,
    right: -4,
    background: '#e53935',
    color: '#fff',
    border: 'none',
    borderRadius: '50%',
    width: 16,
    height: 16,
    fontSize: 11,
    lineHeight: '16px',
    textAlign: 'center' as const,
    cursor: 'pointer',
    padding: 0,
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
