import { useEffect, useState, type CSSProperties } from 'react';
import type { ProductSet } from '../App';

interface RequestRow {
  id: string;
  petName: string | null;
  petType: string;
  brand: string | null;
  queryName: string | null;
  entry: 'name' | 'photo';
  status: string;
  createdAt: string;
}

interface Candidate {
  title: string;
  brand?: string | null;
  url: string;
  domain: string;
}

interface Props {
  onProcessed: (results: ProductSet[]) => void;
  onTotal: (total: number) => void;
}

function waitingLabel(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

export default function RequestsStep({ onProcessed, onTotal }: Props) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [choices, setChoices] = useState<{ id: string; candidates: Candidate[] } | null>(null);

  const load = async () => {
    const res = await fetch('/api/batch/requests');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load requests');
    setRows(data.requests || []);
    setTotal(data.total || 0);
    onTotal(data.total || 0);
  };

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  const open = async (id: string, url?: string) => {
    setOpeningId(id);
    setError('');
    try {
      const res = await fetch(`/api/batch/requests/${id}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(url ? { url } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not open this request');
      if (data.choose) {
        setChoices({ id, candidates: data.candidates || [] });
        return;
      }
      onProcessed([data.review]);
    } catch (err: any) {
      setError(err.message || 'Could not open this request');
    } finally {
      setOpeningId(null);
    }
  };

  if (choices) {
    return (
      <div>
        <button onClick={() => setChoices(null)} style={backBtn}>Requests</button>
        <p style={{ margin: '12px 0' }}>Several pages match. Pick one to fill the review.</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640 }}>
          {choices.candidates.map((page) => (
            <button key={page.url} onClick={() => open(choices.id, page.url)} style={pageBtn} disabled={openingId === choices.id}>
              <strong>{page.title}</strong>
              <span style={{ display: 'block', color: '#5C6B66', fontSize: 13 }}>{page.domain}</span>
            </button>
          ))}
        </div>
        {error ? <p style={{ color: '#9a3412' }}>{error}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <p style={{ margin: '0 0 12px', fontSize: 20 }}>
        <strong style={{ fontSize: 28, marginRight: 6 }}>{total}</strong>
        requests
      </p>
      {error ? <p style={{ color: '#9a3412' }}>{error}</p> : null}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Waiting', 'Pet', 'Kind', 'Request', ''].map((label) => (
              <th key={label} style={th}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const title = [row.brand, row.queryName].filter(Boolean).join(' · ')
              || (row.entry === 'photo' ? 'Front, ingredients, barcode' : 'Name request');
            return (
              <tr key={row.id}>
                <td style={td}>{waitingLabel(row.createdAt)}</td>
                <td style={td}>{row.petName || 'Pet'} · {row.petType}</td>
                <td style={td}>{row.entry === 'photo' ? 'Photo' : 'Name'}</td>
                <td style={td}>{title}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button onClick={() => open(row.id)} disabled={openingId === row.id} style={openBtn}>
                    {openingId === row.id ? 'Opening...' : 'Open'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const th: CSSProperties = {
  textAlign: 'left', fontWeight: 500, fontSize: 13, color: '#5C6B66',
  padding: '12px 8px', borderBottom: '1px solid #E8E4DD',
};
const td: CSSProperties = {
  padding: '12px 8px', borderBottom: '1px solid #E8E4DD', verticalAlign: 'middle',
};
const openBtn: CSSProperties = {
  background: '#fff', border: '1px solid #ccc', borderRadius: 8, padding: '8px 12px', cursor: 'pointer',
};
const backBtn: CSSProperties = {
  background: '#fff', border: '1px solid #ccc', borderRadius: 8, padding: '8px 12px', cursor: 'pointer',
};
const pageBtn: CSSProperties = {
  textAlign: 'left', background: '#fff', border: '1px solid #E8E4DD', borderRadius: 12, padding: 12, cursor: 'pointer',
};
