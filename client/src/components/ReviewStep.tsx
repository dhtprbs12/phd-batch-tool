import React, { useState, useRef } from 'react';
import type { ProductSet } from '../App';
import IngredientEditor from './IngredientEditor';

interface Props {
  queue: ProductSet[];
  onSaved: () => void;
  onDone: () => void;
}

export default function ReviewStep({ queue, onSaved, onDone }: Props) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [editedItems, setEditedItems] = useState<Map<string, ProductSet>>(
    () => new Map(queue.map(q => [q.id, { ...q }]))
  );

  const current = editedItems.get(queue[currentIdx]?.id);
  if (!current) {
    return (
      <div style={{ textAlign: 'center', padding: 40 }}>
        <h2>All products reviewed!</h2>
        <button onClick={onDone} style={styles.doneBtn}>Upload More</button>
      </div>
    );
  }

  const updateExtracted = (field: string, value: any) => {
    setEditedItems(prev => {
      const next = new Map(prev);
      const item = { ...next.get(current.id)! };
      item.extracted = { ...item.extracted, [field]: value };
      next.set(current.id, item);
      return next;
    });
  };

  const updateIngredients = (ingredients: string[]) => {
    setEditedItems(prev => {
      const next = new Map(prev);
      const item = { ...next.get(current.id)! };
      item.ingredients = ingredients;
      next.set(current.id, item);
      return next;
    });
  };

  const updateBarcode = (barcode: string) => {
    setEditedItems(prev => {
      const next = new Map(prev);
      const item = { ...next.get(current.id)! };
      item.barcode = barcode || null;
      next.set(current.id, item);
      return next;
    });
  };

  const updateExtraBarcode = (idx: number, value: string) => {
    setEditedItems(prev => {
      const next = new Map(prev);
      const item = { ...next.get(current.id)! };
      const barcodes = [...(item.extraBarcodes || [])];
      barcodes[idx] = value;
      item.extraBarcodes = barcodes;
      next.set(current.id, item);
      return next;
    });
  };

  const removeExtraBarcode = (idx: number) => {
    setEditedItems(prev => {
      const next = new Map(prev);
      const item = { ...next.get(current.id)! };
      item.extraBarcodes = (item.extraBarcodes || []).filter((_, i) => i !== idx);
      next.set(current.id, item);
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/batch/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: current.id,
          lookupId: current.lookupId,
          extracted: current.extracted,
          ingredients: current.ingredients,
          barcode: current.barcode,
          extraBarcodes: current.extraBarcodes || [],
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.failed) {
          alert('No ingredients, so this request was marked failed. The pet owner will be notified.');
        } else {
          onSaved();
        }
        goNext();
      } else {
        alert(`Save failed: ${data.error}`);
      }
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    }
    setSaving(false);
  };

  const handleSkip = async () => {
    await fetch('/api/batch/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: current.id, lookupId: current.lookupId }),
    });
    goNext();
  };

  const goNext = () => {
    if (currentIdx < queue.length - 1) {
      setCurrentIdx(i => i + 1);
    } else {
      setCurrentIdx(queue.length);
    }
  };

  const goPrev = () => {
    if (currentIdx > 0) setCurrentIdx(i => i - 1);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ fontSize: 18 }}>
          Review Product {currentIdx + 1} / {queue.length}
        </h2>
        <button
          onClick={async () => {
            if (current.lookupId) {
              await fetch('/api/batch/skip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: current.id, lookupId: current.lookupId }),
              });
            }
            onDone();
          }}
          style={styles.backBtn}
        >
          {current.lookupId ? 'Back to requests' : 'Back to Upload'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        {/* Left: Images */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {current.images.front ? <ImageCard label="Front Label" src={current.images.front} /> : null}
          {current.images.ingredients ? <ImageCard label="Ingredients" src={current.images.ingredients} /> : null}
          {current.images.barcode ? <ImageCard label="Barcode" src={current.images.barcode} /> : null}
          {current.sourceUrl ? (
            <p style={{ fontSize: 13, color: '#5C6B66', wordBreak: 'break-all' }}>Source: {current.sourceUrl}</p>
          ) : null}
          {current.warning ? (
            <p style={{ fontSize: 13, color: '#9a3412' }}>{current.warning}</p>
          ) : null}
        </div>

        {/* Right: Extracted data */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Product metadata */}
          <div style={styles.card}>
            <h3 style={{ fontSize: 14, marginBottom: 12, color: '#5C6B66' }}>Product Info</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Field label="Manufacturer" value={current.extracted.manufacturer || ''} onChange={v => updateExtracted('manufacturer', v)} />
              <Field label="Brand" value={current.extracted.brand || ''} onChange={v => updateExtracted('brand', v)} />
              <Field label="Line Name" value={current.extracted.lineName || ''} onChange={v => updateExtracted('lineName', v)} />
              <Field label="Product Name" value={current.extracted.productName || ''} onChange={v => updateExtracted('productName', v)} />
              <SelectField label="Life Stage" value={current.extracted.lifeStage} options={['all', 'puppy', 'kitten', 'adult', 'senior', 'puppy_and_adult']} onChange={v => updateExtracted('lifeStage', v)} />
              <Field label="Product Type" value={current.extracted.productType} onChange={v => updateExtracted('productType', v)} />
              <SelectField label="Breed Size" value={current.extracted.breedSize} options={['all', 'large_breed', 'small_breed']} onChange={v => updateExtracted('breedSize', v)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
              <ProteinField
                label="Primary Proteins"
                hint="Heaviest first. Comma separated. chicken, poultry, salmon, whitefish"
                values={current.extracted.primaryProteins || []}
                onChange={v => updateExtracted('primaryProteins', v)}
              />
              <ArrayField
                label="Diet Tags"
                hint="grain_free or with_grains, plus limited_ingredient"
                values={current.extracted.dietTags || []}
                onChange={v => updateExtracted('dietTags', v)}
              />
            </div>
          </div>

          {/* Barcode */}
          <div style={styles.card}>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: '#5C6B66' }}>Barcode</h3>
            <input
              type="text"
              value={current.barcode || ''}
              onChange={e => updateBarcode(e.target.value)}
              placeholder="Barcode value"
              style={styles.input}
            />
            {current.extraBarcodes && current.extraBarcodes.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>
                  + {current.extraBarcodes.length} variant barcode{current.extraBarcodes.length > 1 ? 's' : ''} (different sizes)
                </p>
                {current.extraBarcodes.map((bc, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: '#888', minWidth: 20 }}>#{i + 1}</span>
                    <input
                      type="text"
                      value={bc}
                      onChange={e => updateExtraBarcode(i, e.target.value)}
                      style={{ ...styles.input, flex: 1, marginBottom: 0 }}
                    />
                    <button onClick={() => removeExtraBarcode(i)} style={{ background: 'none', border: 'none', color: '#e53935', cursor: 'pointer', fontSize: 14 }}>×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Ingredients */}
          <div style={styles.card}>
            <h3 style={{ fontSize: 14, marginBottom: 8, color: '#5C6B66' }}>
              Ingredients ({current.ingredients.length})
            </h3>
            <IngredientEditor
              ingredients={current.ingredients}
              onChange={updateIngredients}
            />
          </div>

          {/* Action buttons */}
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <button onClick={goPrev} disabled={currentIdx === 0} style={{ ...styles.skipBtn, opacity: currentIdx === 0 ? 0.4 : 1 }}>← Prev</button>
            <button onClick={handleSave} disabled={saving} style={styles.saveBtn}>
              {saving ? 'Saving...' : 'Approve & Save'}
            </button>
            <button onClick={handleSkip} style={styles.skipBtn}>Skip</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImageCard({ label, src }: { label: string; src: string }) {
  const [zoomed, setZoomed] = useState(false);
  const [turns, setTurns] = useState(0);
  const rotation = { transform: `rotate(${turns * 90}deg)` };
  return (
    <>
      <div style={styles.imageCard}>
        <div onClick={() => setZoomed(true)} style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <img src={src} style={{ width: '100%', maxHeight: 220, objectFit: 'contain', borderRadius: 8, ...rotation }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <p style={{ fontSize: 12, color: '#888', margin: 0 }}>{label}</p>
          <button type="button" onClick={() => setTurns(value => value + 1)} style={styles.rotateBtn}>Rotate</button>
        </div>
      </div>
      {zoomed && (
        <div style={styles.zoomOverlay} onClick={() => setZoomed(false)}>
          <img src={src} style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', ...rotation }} />
        </div>
      )}
    </>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: '#888' }}>{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} style={styles.input} />
    </div>
  );
}

function proteinParts(text: string) {
  const idx = text.lastIndexOf(',');
  const prior = (idx === -1 ? [] : text.slice(0, idx).split(','))
    .map((part) => part.trim())
    .filter(Boolean);
  const fragment = (idx === -1 ? text : text.slice(idx + 1)).trim();
  return { prior, fragment };
}

function ProteinField({ label, hint, values, onChange }: { label: string; hint?: string; values: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState((values || []).join(', '));
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const prevValues = useRef(values);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picking = useRef(false);
  if (values !== prevValues.current) {
    prevValues.current = values;
    setText((values || []).join(', '));
  }

  const commit = (next: string) => {
    onChange(next.split(',').map((part) => part.trim()).filter(Boolean));
  };

  const fetchSuggestions = (next: string) => {
    const { prior, fragment } = proteinParts(next);
    if (fragment.length < 1) {
      setSuggestions([]);
      return;
    }
    const params = new URLSearchParams({ q: fragment, exclude: prior.join(',') });
    fetch(`/api/batch/proteins/suggest?${params}`)
      .then((res) => res.json())
      .then((data) => setSuggestions(Array.isArray(data) ? data : []))
      .catch(() => setSuggestions([]));
  };

  const selectSuggestion = (suggestion: string) => {
    const idx = text.lastIndexOf(',');
    const head = idx === -1 ? '' : `${text.slice(0, idx).trimEnd()}, `;
    const next = `${head}${suggestion}, `;
    setText(next);
    setSuggestions([]);
  };

  return (
    <div style={{ position: 'relative' }}>
      <label style={{ fontSize: 11, color: '#888' }}>{label}</label>
      <input
        type="text"
        value={text}
        placeholder={hint}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (debounceRef.current) clearTimeout(debounceRef.current);
          debounceRef.current = setTimeout(() => fetchSuggestions(next), 150);
        }}
        onBlur={() => {
          setTimeout(() => {
            if (picking.current) {
              picking.current = false;
              return;
            }
            setSuggestions([]);
            commit(text);
          }, 150);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && suggestions.length > 0) {
            event.preventDefault();
            selectSuggestion(suggestions[0]);
          }
        }}
        style={styles.input}
      />
      {suggestions.length > 0 ? (
        <div style={styles.suggestBox}>
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onMouseDown={() => { picking.current = true; selectSuggestion(suggestion); }}
              style={styles.suggestItem}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArrayField({ label, hint, values, onChange }: { label: string; hint?: string; values: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState((values || []).join(', '));
  const prevId = useRef(values);
  if (values !== prevId.current) {
    prevId.current = values;
    setText((values || []).join(', '));
  }
  return (
    <div>
      <label style={{ fontSize: 11, color: '#888' }}>{label}</label>
      <input
        type="text"
        value={text}
        placeholder={hint}
        onChange={e => setText(e.target.value)}
        onBlur={() => onChange(text.split(',').map(s => s.trim()).filter(Boolean))}
        style={styles.input}
      />
    </div>
  );
}

function SelectField({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: '#888' }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={styles.input}>
        {options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    background: '#fff',
    borderRadius: 12,
    padding: 16,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  },
  imageCard: {
    background: '#fff',
    borderRadius: 12,
    padding: 12,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
    cursor: 'pointer',
  },
  input: {
    width: '100%',
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ddd',
    fontSize: 13,
    outline: 'none',
  },
  suggestBox: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    background: '#fff',
    border: '1px solid #ddd',
    borderRadius: 8,
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    zIndex: 20,
    maxHeight: 180,
    overflowY: 'auto',
  },
  suggestItem: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    background: '#fff',
    border: 'none',
    padding: '8px 10px',
    fontSize: 13,
    cursor: 'pointer',
  },
  saveBtn: {
    flex: 1,
    background: '#2e7d56',
    color: '#fff',
    border: 'none',
    padding: '12px 20px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  skipBtn: {
    background: '#fff',
    border: '1px solid #ccc',
    color: '#666',
    padding: '12px 20px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  rotateBtn: {
    background: 'none',
    border: '1px solid #ccc',
    color: '#5C6B66',
    fontSize: 11,
    borderRadius: 4,
    padding: '2px 8px',
    cursor: 'pointer',
  },
  backBtn: {
    background: 'none',
    border: '1px solid #ccc',
    color: '#666',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  doneBtn: {
    background: '#2e7d56',
    color: '#fff',
    border: 'none',
    padding: '12px 24px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
    marginTop: 16,
  },
  zoomOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    cursor: 'pointer',
  },
};
