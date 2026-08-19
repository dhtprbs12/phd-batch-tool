import React, { useState, useRef, useEffect, useCallback } from 'react';

interface Props {
  ingredients: string[];
  onChange: (ingredients: string[]) => void;
}

export default function IngredientEditor({ ingredients, onChange }: Props) {
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handleEdit = (idx: number, value: string) => {
    const next = [...ingredients];
    next[idx] = value;
    onChange(next);
  };

  const handleDelete = (idx: number) => {
    onChange(ingredients.filter((_, i) => i !== idx));
    setEditingIdx(null);
  };

  const handleAdd = (afterIdx: number) => {
    const next = [...ingredients];
    next.splice(afterIdx + 1, 0, '');
    onChange(next);
    setEditingIdx(afterIdx + 1);
  };

  const handleAddEnd = () => {
    onChange([...ingredients, '']);
    setEditingIdx(ingredients.length);
  };

  const handleCopy = () => {
    const text = ingredients.join(', ');
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopyMsg('Copied!');
      setTimeout(() => setCopyMsg(''), 1500);
    } catch {
      prompt('Copy this:', text);
    }
  };

  const handlePaste = () => {
    const text = prompt('Paste ingredients (comma-separated):');
    if (text) {
      const parsed = text.split(',').map(s => s.trim()).filter(Boolean);
      if (parsed.length > 0) {
        onChange(parsed);
        setEditingIdx(null);
      }
    }
  };

  const [copyMsg, setCopyMsg] = useState('');

  const handleDragStart = (idx: number) => {
    setDragIdx(idx);
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };

  const handleDrop = (idx: number) => {
    if (dragIdx === null || dragIdx === idx) {
      setDragIdx(null);
      setDragOverIdx(null);
      return;
    }
    const next = [...ingredients];
    const [moved] = next.splice(dragIdx, 1);
    const targetIdx = dragIdx < idx ? idx - 1 : idx;
    next.splice(targetIdx, 0, moved);
    onChange(next);
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const handleDragEnd = () => {
    setDragIdx(null);
    setDragOverIdx(null);
  };

  return (
    <div>
      <div style={styles.toolbar}>
        <button onClick={handleCopy} style={styles.toolBtn} title="Copy all ingredients">
          📋 Copy {copyMsg && <span style={{ color: '#2e7d56', marginLeft: 4 }}>{copyMsg}</span>}
        </button>
        <button onClick={handlePaste} style={styles.toolBtn} title="Paste ingredients (comma-separated)">
          📥 Paste
        </button>
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {ingredients.map((ing, idx) => (
          <div
            key={idx}
            draggable={editingIdx !== idx}
            onDragStart={() => handleDragStart(idx)}
            onDragOver={(e) => handleDragOver(e, idx)}
            onDrop={() => handleDrop(idx)}
            onDragEnd={handleDragEnd}
            style={{
              borderTop: dragOverIdx === idx && dragIdx !== null && dragIdx !== idx ? '2px solid #2e7d56' : 'none',
              opacity: dragIdx === idx ? 0.4 : 1,
            }}
          >
            <IngredientRow
              index={idx}
              value={ing}
              isEditing={editingIdx === idx}
              onStartEdit={() => setEditingIdx(idx)}
              onStopEdit={() => setEditingIdx(null)}
              onChange={v => handleEdit(idx, v)}
              onDelete={() => handleDelete(idx)}
              onAddBelow={() => handleAdd(idx)}
            />
          </div>
        ))}
        <button onClick={handleAddEnd} style={styles.addBtn}>+ Add Ingredient</button>
      </div>
    </div>
  );
}

function IngredientRow({
  index,
  value,
  isEditing,
  onStartEdit,
  onStopEdit,
  onChange,
  onDelete,
  onAddBelow,
}: {
  index: number;
  value: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onChange: (v: string) => void;
  onDelete: () => void;
  onAddBelow: () => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isEditing]);

  const fetchSuggestions = useCallback(async (q: string) => {
    if (q.length < 2) { setSuggestions([]); return; }
    try {
      const res = await fetch(`/api/batch/ingredients/suggest?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setSuggestions(data);
      setShowSuggestions(data.length > 0);
    } catch { setSuggestions([]); }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    onChange(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(v), 200);
  };

  const selectSuggestion = (s: string) => {
    onChange(s);
    setShowSuggestions(false);
    setSuggestions([]);
  };

  if (!isEditing) {
    return (
      <div style={styles.row}>
        <span style={styles.dragHandle} title="Drag to reorder">⠿</span>
        <span style={styles.idx}>{index + 1}.</span>
        <span style={styles.text} onClick={onStartEdit}>{value || '(empty)'}</span>
        <button onClick={onAddBelow} style={styles.smallBtn} title="Add below">+</button>
        <button onClick={onDelete} style={{ ...styles.smallBtn, color: '#e53935' }} title="Delete">✕</button>
      </div>
    );
  }

  return (
    <div style={{ ...styles.row, background: '#f0faf5', position: 'relative' }}>
      <span style={styles.idx}>{index + 1}.</span>
      <input
        ref={inputRef}
        value={value}
        onChange={handleChange}
        onBlur={() => { setTimeout(() => { setShowSuggestions(false); onStopEdit(); }, 150); }}
        onKeyDown={e => { if (e.key === 'Enter') onStopEdit(); }}
        style={styles.editInput}
      />
      <button onClick={onAddBelow} style={styles.smallBtn} title="Add below">+</button>
      <button onClick={onDelete} style={{ ...styles.smallBtn, color: '#e53935' }} title="Delete">✕</button>

      {showSuggestions && suggestions.length > 0 && (
        <div style={styles.suggestBox}>
          {suggestions.map((s, i) => (
            <div
              key={i}
              style={styles.suggestItem}
              onMouseDown={() => selectSuggestion(s)}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: {
    display: 'flex',
    gap: 8,
    marginBottom: 8,
  },
  toolBtn: {
    background: '#f5f5f5',
    border: '1px solid #ddd',
    borderRadius: 6,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
  },
  dragHandle: {
    cursor: 'grab',
    color: '#bbb',
    fontSize: 14,
    userSelect: 'none' as const,
    padding: '0 2px',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderRadius: 6,
    marginBottom: 2,
    position: 'relative',
  },
  idx: {
    fontSize: 11,
    color: '#999',
    width: 24,
    textAlign: 'right',
    flexShrink: 0,
  },
  text: {
    flex: 1,
    fontSize: 13,
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: 4,
  },
  editInput: {
    flex: 1,
    fontSize: 13,
    padding: '4px 8px',
    border: '1px solid #2e7d56',
    borderRadius: 6,
    outline: 'none',
  },
  smallBtn: {
    background: 'none',
    border: 'none',
    fontSize: 14,
    cursor: 'pointer',
    color: '#2e7d56',
    padding: '2px 6px',
    borderRadius: 4,
  },
  addBtn: {
    background: 'none',
    border: '1px dashed #aaa',
    color: '#666',
    width: '100%',
    padding: '6px',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    marginTop: 6,
  },
  suggestBox: {
    position: 'absolute',
    top: '100%',
    left: 30,
    right: 50,
    background: '#fff',
    border: '1px solid #ddd',
    borderRadius: 8,
    boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
    zIndex: 100,
    maxHeight: 180,
    overflowY: 'auto',
  },
  suggestItem: {
    padding: '6px 12px',
    fontSize: 13,
    cursor: 'pointer',
    borderBottom: '1px solid #f0f0f0',
  },
};
