import { useState, type CSSProperties } from 'react';
import type { ProductSet } from '../App';
import IngredientEditor from './IngredientEditor';
import { ArrayField, Field, ProteinField, SelectField } from './ReviewStep';

const MAX_PRODUCTS = 20;

const TEXTURE_OPTIONS = [
  { value: 'dry', label: 'dry (건식)' },
  { value: 'wet', label: 'wet (습식)' },
  { value: 'semi_moist', label: 'semi_moist' },
  { value: 'freeze_dried', label: 'freeze_dried' },
];

interface Props {
  onSaved: () => void;
  onDone: () => void;
}

function blankProduct(): ProductSet {
  return {
    id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'pending_review',
    entry: 'name',
    images: { front: null, ingredients: null, barcode: null },
    extracted: {
      manufacturer: null,
      brand: null,
      lineName: null,
      productName: null,
      lifeStage: 'all',
      primaryProteins: [],
      petType: 'dog',
      productType: 'dry_food',
      texture: 'dry',
      breedSize: 'all',
      dietTags: [],
    },
    ingredients: [],
    rawIngredientsText: '',
    barcode: null,
    extraBarcodes: [],
  };
}

export default function ManualReview({ onSaved, onDone }: Props) {
  const [items, setItems] = useState<ProductSet[]>(() => [blankProduct()]);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingAll, setSavingAll] = useState(false);
  const [progress, setProgress] = useState('');

  const updateItem = (id: string, recipe: (item: ProductSet) => ProductSet) => {
    setItems(prev => prev.map(item => (item.id === id ? recipe(item) : item)));
  };

  const updateExtracted = (id: string, field: string, value: string | string[]) => {
    updateItem(id, item => ({
      ...item,
      extracted: { ...item.extracted, [field]: value },
    }));
  };

  const readyToSave = (item: ProductSet) => {
    const name = item.extracted.productName || item.extracted.brand || item.extracted.lineName;
    return Boolean(name && item.ingredients.some(ingredient => ingredient.trim()));
  };

  const saveOne = async (item: ProductSet) => {
    const ingredients = item.ingredients.map(ingredient => ingredient.trim()).filter(Boolean);
    const res = await fetch('/api/batch/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: item.id,
        extracted: item.extracted,
        ingredients,
        barcode: item.barcode,
        extraBarcodes: (item.extraBarcodes || []).map(value => value.trim()).filter(Boolean),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Save failed');
    setSavedIds(prev => new Set(prev).add(item.id));
    onSaved();
  };

  const handleSave = async (item: ProductSet) => {
    setSavingId(item.id);
    try {
      await saveOne(item);
    } catch (e: any) {
      alert(`Save failed: ${e.message}`);
    }
    setSavingId(null);
  };

  const handleSaveAll = async () => {
    const pending = items.filter(item => !savedIds.has(item.id));
    const missing = pending.find(item => !readyToSave(item));
    if (missing) {
      alert(`Product ${items.findIndex(item => item.id === missing.id) + 1} needs a name and at least one ingredient.`);
      return;
    }
    setSavingAll(true);
    for (let i = 0; i < pending.length; i++) {
      setProgress(`Saving ${i + 1} / ${pending.length}...`);
      try {
        await saveOne(pending[i]);
      } catch (e: any) {
        alert(`Product ${items.findIndex(item => item.id === pending[i].id) + 1} failed: ${e.message}`);
        break;
      }
    }
    setProgress('');
    setSavingAll(false);
  };

  const busy = savingId !== null || savingAll;
  const unsaved = items.filter(item => !savedIds.has(item.id));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 18, margin: 0 }}>Manual input</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#5C6B66' }}>
            Fill in the same fields as Approve & Save. Up to {MAX_PRODUCTS}. Each save stores those values and runs analysis for that product only.
          </p>
        </div>
        <button type="button" onClick={onDone} style={styles.backBtn}>Back to Upload</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map((item, index) => {
          const saved = savedIds.has(item.id);
          return (
            <div key={item.id} style={{ ...styles.card, opacity: saved ? 0.65 : 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <strong style={{ fontSize: 14 }}>Product {index + 1}</strong>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {saved && <span style={styles.saved}>Saved</span>}
                  {items.length > 1 && !saved && (
                    <button type="button" onClick={() => setItems(prev => prev.filter(row => row.id !== item.id))} style={styles.removeBtn}>
                      Remove
                    </button>
                  )}
                </div>
              </div>

              <div style={styles.section}>
                <h3 style={styles.sectionTitle}>Product Info</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <Field label="Manufacturer" value={item.extracted.manufacturer || ''} onChange={v => updateExtracted(item.id, 'manufacturer', v)} />
                  <Field label="Brand" value={item.extracted.brand || ''} onChange={v => updateExtracted(item.id, 'brand', v)} />
                  <Field label="Line Name" value={item.extracted.lineName || ''} onChange={v => updateExtracted(item.id, 'lineName', v)} />
                  <Field label="Product Name" value={item.extracted.productName || ''} onChange={v => updateExtracted(item.id, 'productName', v)} />
                  <SelectField label="Life Stage" value={item.extracted.lifeStage} options={['all', 'puppy', 'kitten', 'adult', 'senior', 'puppy_and_adult']} onChange={v => updateExtracted(item.id, 'lifeStage', v)} />
                  <Field label="Product Type" value={item.extracted.productType} onChange={v => updateExtracted(item.id, 'productType', v)} />
                  <SelectField label="Breed Size" value={item.extracted.breedSize} options={['all', 'large_breed', 'small_breed']} onChange={v => updateExtracted(item.id, 'breedSize', v)} />
                  <SelectField label="Texture" value={item.extracted.texture || 'dry'} options={TEXTURE_OPTIONS} onChange={v => updateExtracted(item.id, 'texture', v)} />
                  <SelectField label="Pet Type" value={item.extracted.petType} options={['dog', 'cat', 'both']} onChange={v => updateExtracted(item.id, 'petType', v)} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                  <ProteinField
                    label="Primary Proteins"
                    hint="Heaviest first. Comma separated. chicken, poultry, salmon, whitefish"
                    values={item.extracted.primaryProteins || []}
                    onChange={v => updateExtracted(item.id, 'primaryProteins', v)}
                  />
                  <ArrayField
                    label="Diet Tags"
                    hint="grain_free or with_grains, plus limited_ingredient"
                    values={item.extracted.dietTags || []}
                    onChange={v => updateExtracted(item.id, 'dietTags', v)}
                  />
                </div>
              </div>

              <div style={styles.section}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <h3 style={{ ...styles.sectionTitle, marginBottom: 0 }}>Barcode</h3>
                  <button
                    type="button"
                    onClick={() => updateItem(item.id, row => ({ ...row, extraBarcodes: [...(row.extraBarcodes || []), ''] }))}
                    style={styles.addBarcodeBtn}
                  >
                    + Barcode
                  </button>
                </div>
                <input
                  type="text"
                  value={item.barcode || ''}
                  onChange={e => updateItem(item.id, row => ({ ...row, barcode: e.target.value || null }))}
                  placeholder="Barcode value"
                  style={styles.input}
                />
                {(item.extraBarcodes || []).map((barcode, barcodeIdx) => (
                  <div key={barcodeIdx} style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                    <span style={{ fontSize: 11, color: '#888', minWidth: 20 }}>#{barcodeIdx + 1}</span>
                    <input
                      type="text"
                      value={barcode}
                      onChange={e => updateItem(item.id, row => {
                        const extraBarcodes = [...(row.extraBarcodes || [])];
                        extraBarcodes[barcodeIdx] = e.target.value;
                        return { ...row, extraBarcodes };
                      })}
                      style={{ ...styles.input, flex: 1, marginTop: 0 }}
                    />
                    <button
                      type="button"
                      onClick={() => updateItem(item.id, row => ({
                        ...row,
                        extraBarcodes: (row.extraBarcodes || []).filter((_, i) => i !== barcodeIdx),
                      }))}
                      style={styles.removeBtn}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <div style={styles.section}>
                <h3 style={styles.sectionTitle}>
                  Ingredients ({item.ingredients.filter(ingredient => ingredient.trim()).length})
                </h3>
                <IngredientEditor
                  ingredients={item.ingredients}
                  onChange={ingredients => updateItem(item.id, row => ({
                    ...row,
                    ingredients,
                    rawIngredientsText: ingredients.join(', '),
                  }))}
                />
              </div>

              <button
                type="button"
                onClick={() => handleSave(item)}
                disabled={busy || saved || !readyToSave(item)}
                style={{ ...styles.saveBtn, opacity: busy || saved || !readyToSave(item) ? 0.5 : 1 }}
              >
                {savingId === item.id ? 'Saving...' : saved ? 'Saved' : 'Approve & Save'}
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <button
          type="button"
          onClick={() => setItems(prev => (prev.length >= MAX_PRODUCTS ? prev : [...prev, blankProduct()]))}
          disabled={items.length >= MAX_PRODUCTS || busy}
          style={{ ...styles.secondaryBtn, opacity: items.length >= MAX_PRODUCTS || busy ? 0.5 : 1 }}
        >
          {items.length >= MAX_PRODUCTS ? `${MAX_PRODUCTS} max` : `Add product (${items.length}/${MAX_PRODUCTS})`}
        </button>
        <button
          type="button"
          onClick={handleSaveAll}
          disabled={busy || unsaved.length === 0}
          style={{ ...styles.saveBtn, opacity: busy || unsaved.length === 0 ? 0.5 : 1 }}
        >
          {savingAll ? progress : `Approve & save all (${unsaved.length})`}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    background: '#fff',
    borderRadius: 12,
    padding: 16,
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  section: {
    background: '#f7f8f7',
    borderRadius: 10,
    padding: 12,
  },
  sectionTitle: {
    fontSize: 14,
    margin: '0 0 12px',
    color: '#5C6B66',
  },
  input: {
    width: '100%',
    padding: '6px 10px',
    borderRadius: 6,
    border: '1px solid #ddd',
    fontSize: 13,
    outline: 'none',
    marginTop: 2,
  },
  saveBtn: {
    background: '#2e7d56',
    color: '#fff',
    border: 'none',
    padding: '12px 20px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
  },
  secondaryBtn: {
    background: '#fff',
    border: '1px solid #2e7d56',
    color: '#2e7d56',
    padding: '12px 20px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: 14,
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
  backBtn: {
    background: 'none',
    border: '1px solid #ccc',
    color: '#666',
    padding: '6px 14px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
  removeBtn: {
    background: 'none',
    border: 'none',
    color: '#e53935',
    fontSize: 12,
    cursor: 'pointer',
  },
  saved: {
    fontSize: 12,
    color: '#2e7d56',
    background: '#e8f5e9',
    padding: '2px 8px',
    borderRadius: 10,
    fontWeight: 600,
  },
};
